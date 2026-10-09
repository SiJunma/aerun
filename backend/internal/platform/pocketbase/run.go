package pocketbase

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
	"github.com/SiJunma/aerun/backend/internal/config"
)

const (
	startupTimeout      = 15 * time.Second
	healthCheckInterval = 200 * time.Millisecond
	healthPath          = "/api/aerun/health"
)

// Run starts the PocketBase host for cfg and blocks until the process ends.
// Domain packages stay PocketBase-free: only this adapter knows the framework.
func Run(cfg config.Config, logger *slog.Logger) error {
	// Defense in depth: fail fast on invalid/missing secrets before any server,
	// database or listener exists.
	if err := config.Validate(cfg, nil); err != nil {
		return err
	}

	pb := pocketbase.NewWithConfig(pocketbase.Config{
		DefaultDataDir: cfg.DataDir,
		// Settings are encrypted only while AERUN_ENCRYPTION_KEY is present
		// (required by config.Validate in production); with an empty key value
		// PocketBase stores settings as plaintext, so local runs stay keyless.
		// Verified against core/settings_model.go in PocketBase v0.40.4.
		DefaultEncryptionEnv: "AERUN_ENCRYPTION_KEY",
	})

	pb.OnServe().BindFunc(func(se *core.ServeEvent) error {
		se.Router.BindFunc(assignRequestID)
		// PocketBase starts its scheduler from an OnServe hook bound at
		// priority 999, so a job registered here is always in place before the
		// first tick (see registerGuestPresenceCron).
		if err := registerGuestPresenceCron(se.App); err != nil {
			return err
		}
		// TASK-4: the outbox worker existed but was never scheduled, so no
		// queued email could ever leave the queue. Registered here, at the same
		// point and for the same reason as the prune above: PocketBase starts
		// its scheduler at priority 999, after this hook.
		if err := registerOutboxWorkerCron(se.App); err != nil {
			return err
		}
		// Fail fast on a binary/data-directory mismatch. touchMemberLastSeen
		// cannot report this: it is best-effort by design, so a missing column
		// would degrade the members table to registration dates with a 200 on
		// every heartbeat and no other signal anywhere.
		if err := verifyPresenceSchema(se.App); err != nil {
			return err
		}
		// Sprint 2 task 3: the Google login follows the environment on every
		// startup (same defense-in-depth idea as the SMTP reset in OnBootstrap
		// below). It runs here — after apis.Serve applied RunAllMigrations —
		// so credentials that arrive after a first credential-less boot still
		// enable the provider without a new migration.
		if err := configureOAuth2(se.App, cfg); err != nil {
			return err
		}
		// Same reasoning for mail: the relay is environment state, and this hook
		// runs after apis.Serve applied RunAllMigrations, so a relay supplied or
		// rotated after the first boot takes effect without a new migration. It
		// must also run before registerRoutes' traffic reaches the auth handlers
		// and before the outbox cron's first tick.
		if err := configureSMTP(se.App, cfg); err != nil {
			return err
		}
		// Same reasoning for the auth mail templates: they are deployment content
		// on the users collection, not schema, so they reconcile on every boot
		// rather than freezing at whatever a migration found.
		if err := configureAuthTemplates(se.App, cfg); err != nil {
			return err
		}
		registerAuthMailHooks(se.App)
		registerRoutes(se, cfg)
		// Records every completed identity-provider sign-in, so the chief-admin
		// handover can accept "sign in with Google again" as proof of identity
		// for an account that has no usable password. See oauth_signin_recent.go.
		registerOAuthSignInHook(se.App)
		// Promotes a still-pending forum account to active on sign-in when the
		// "require approval" gate is off — the server-side half of that switch
		// that nothing used to honour. See account_activation.go.
		registerAccountActivationHook(se.App)
		return se.Next()
	})

	// Sprint 2 mail guardrail: intercept every outgoing email at the app
	// hook level before an SMTP connection or sendmail exec can happen.
	//
	// Bound ONLY in the disabled mode. It was unconditional until Sprint 8,
	// which is why a configured relay could never deliver anything: the guard
	// returned 503 for every message regardless of AERUN_MAIL_MODE, so
	// switching the mode changed nothing. In "smtp" and "dashboard" modes
	// there is nothing to guard against: smtp opted in explicitly (and
	// config.Validate refused to boot on an incomplete relay), dashboard
	// makes the PocketBase admin UI the operator's surface — a relay that is
	// not configured yet simply fails at the connection, which the senders
	// report, rather than being vetoed here.
	if cfg.MailMode == MailModeDisabled {
		pb.OnMailerSend().BindFunc(MailHardDisableGuard())
	}

	pb.OnBootstrap().BindFunc(func(e *core.BootstrapEvent) error {
		if err := e.Next(); err != nil {
			return err
		}
		// The mail settings themselves are owned by configureSMTP in OnServe, which
		// runs after migrations and therefore also fixes a relay that was rotated
		// or first supplied after the initial boot. This hook keeps only the
		// Meta defaults it always owned.
		//
		// It no longer forces SMTP.Enabled=false: with the mode in "smtp" that line
		// silently undid the relay configuration on every restart, which is the
		// second half of why email could never work. In "disabled" mode
		// configureSMTP clears the flag anyway, and this hook still resets it
		// before the first OnServe so nothing can send during startup.
		// In "disabled" mode configureSMTP clears the flag anyway, and this hook
		// still resets it before the first OnServe so nothing can send during
		// startup. In "dashboard" mode the flag BELONGS to the admin UI — the
		// whole point of the mode is that the operator turns email on there —
		// so it must not be forced off here either.
		settings := pb.Settings()
		settings.Meta.AppName = "Aerun"
		settings.Meta.AppURL = cfg.PublicURL
		if settings.Meta.SenderAddress == "" {
			settings.Meta.SenderAddress = "no-reply@aerun.invalid"
		}
		if settings.Meta.SenderName == "" {
			settings.Meta.SenderName = "Aerun"
		}
		if cfg.MailMode == MailModeDisabled {
			settings.SMTP.Enabled = false
		}
		return pb.Save(settings)
	})

	// apis.Serve requires a bootstrapped app (DB connections, settings, system
	// tables). pb.Start() used to bootstrap implicitly; the programmatic path
	// must do it explicitly before serving.
	if err := pb.Bootstrap(); err != nil {
		return fmt.Errorf("bootstrap: %w", err)
	}

	// Explicit programmatic serve. Verified against v0.40.4: pb.Start() with no
	// arguments only bootstraps, prints the cobra help and exits — it never
	// serves and never applies app migrations (RunAllMigrations runs only
	// inside the serve command). apis.Serve blocks for the process lifetime,
	// applies every new migration itself, triggers OnServe on its own router
	// and never parses os.Args, so the env-only configuration (CLI arguments
	// stay rejected) holds for local and VPS deployments alike. The listener
	// is the validated loopback AERUN_LISTEN; production terminates TLS in a
	// reverse proxy in front of this address. CORS is PocketBase's own
	// apis.CORS middleware fed by the validated origins allowlist (proper
	// per-origin echo; the invalid comma-joined custom header is gone).
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- apis.Serve(pb, apis.ServeConfig{
			ShowStartBanner: false,
			HttpAddr:        cfg.Listen,
			AllowedOrigins:  cfg.Origins,
		})
	}()

	// Relay termination signals into PocketBase's OnTerminate hook, where
	// apis.Serve binds its graceful HTTP shutdown (mirrors pb.Start()).
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)

	select {
	case err := <-serveErr:
		return err
	case <-sigCh:
		termErr := pb.OnTerminate().Trigger(&core.TerminateEvent{App: pb}, func(e *core.TerminateEvent) error {
			return e.App.ClearBootstrap()
		})
		return errors.Join(termErr, <-serveErr)
	case <-time.After(startupTimeout):
	}

	// The listener is up or about to fail; self-probe the health endpoint.
	url := fmt.Sprintf("http://%s", cfg.Listen)
	client := &http.Client{Timeout: 2 * time.Second}
	var lastErr error
	deadline := time.Now().Add(startupTimeout)
	for time.Now().Before(deadline) {
		resp, err := client.Get(url + healthPath)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				logger.Info("backend healthy",
					"env", cfg.Environment, "listen", cfg.Listen,
					"data_dir", cfg.DataDir, "health", healthPath)
				// Block until the server stops; returning earlier would let main
				// exit and kill the freshly started backend process.
				return <-serveErr
			}
			lastErr = fmt.Errorf("health status %d", resp.StatusCode)
		} else {
			lastErr = err
		}
		time.Sleep(healthCheckInterval)
	}
	// Prefer the actual serve failure (e.g. busy port) over the probe timeout.
	select {
	case err := <-serveErr:
		return err
	default:
	}
	// Surface the probe failure; main exits and the process stops.
	return fmt.Errorf("health check failed after %s at %s: %w", startupTimeout, url, lastErr)
}

func registerRoutes(se *core.ServeEvent, cfg config.Config) {
	// The AccessResolver middleware runs for every /api/aerun route; custom
	// command routes bound later in this group can then use RequirePermission.
	resolver := NewAccessResolver(se.App.Logger())
	group := se.Router.Group("/api/aerun")
	group.BindFunc(errorContractMiddleware)
	group.BindFunc(resolver.Middleware())

	group.GET("/health", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, map[string]any{
			"status":      "ok",
			"service":     "aerun-backend",
			"environment": cfg.Environment,
			"request_id":  requestIDFrom(e),
		})
	})

	// Unified status & health probe (combines liveness check with presence stats)
	group.GET("/status", statusHandler)

	// Global forum settings (public snapshot read, admin write)
	group.GET("/settings", getGlobalSettingsHandler)
	group.PATCH("/admin/settings", updateGlobalSettingsHandler(cfg)).
		BindFunc(RequirePermission(auth.PermAdminAccess)).BindFunc(enforceIdempotency)
	group.PUT("/admin/settings", updateGlobalSettingsHandler(cfg)).
		BindFunc(RequirePermission(auth.PermAdminAccess)).BindFunc(enforceIdempotency)

	group.GET("/me", meHandler)
	group.PUT("/me/settings", updateSettingsHandler)
	// No enforceIdempotency: that middleware buffers the body and caps it at
	// 512 KB, which a multipart avatar can never satisfy (see avatar_upload.go).
	group.PUT("/me/avatar", uploadMyAvatarHandler)
	// Nicknames. Self-service needs no route-level permission: the handler
	// checks `edit_self_nickname` so a role that has it revoked by the status
	// narrowing is refused, and the rank matrix lives in the handler because
	// it is not expressible as a single permission.
	group.PATCH("/me/nickname", changeMyNicknameHandler).BindFunc(enforceIdempotency)
	group.PATCH("/users/{id}/nickname", changeUserNicknameHandler).BindFunc(enforceIdempotency)
	// Profile fields. The legacy profile form used to save through the ADMIN
	// route, which silently discarded everything but role and status — see
	// profile_commands.go for the two ways that failed.
	group.PATCH("/me/profile", updateMyProfileHandler)
	group.PATCH("/users/{id}/profile", updateUserProfileHandler).BindFunc(enforceIdempotency)

	// Sign-in credentials. The legacy Security tab called
	// pb.collection('users').update(), which this backend refuses by design
	// (users.UpdateRule = nil), so the whole tab had no save path — see
	// account_credentials.go. Each mutation carries enforceIdempotency: they are
	// destructive-if-repeated (a re-sent password change re-hashes, a re-sent
	// email change is a second audit row) and a double-clicked Save must not
	// produce two of either.
	group.GET("/me/auth", listMyAuthMethodsHandler)
	group.PUT("/me/password", changeMyPasswordHandler).BindFunc(enforceIdempotency)
	group.PATCH("/me/email", changeMyEmailHandler).BindFunc(enforceIdempotency)
	group.DELETE("/me/auth/{provider}", unlinkMyAuthProviderHandler).BindFunc(enforceIdempotency)

	// Sprint 2 identity commands.
	group.POST("/auth/register", registerHandler)
	group.POST("/auth/resend-verification", resendVerificationHandler).BindFunc(enforceIdempotency)
	group.GET("/admin/users", adminListUsersHandler).BindFunc(RequirePermission(auth.PermAdminAccess))
	group.PATCH("/admin/users/{id}", adminUpdateUserHandler).BindFunc(RequirePermission(auth.PermAdminAccess)).BindFunc(enforceIdempotency)
	group.DELETE("/admin/users/{id}", adminDeleteUserHandler).BindFunc(RequirePermission(auth.PermAdminAccess)).BindFunc(enforceIdempotency)
	// The root role changes hands only through this command; a plain role write
	// refuses it for every caller (see checkRoleChange). Gated on admin_access
	// as a cheap first gate, but the handler demands the root role AND the
	// caller's password — see root_transfer.go.
	group.POST("/admin/transfer-root", transferRootHandler).BindFunc(RequirePermission(auth.PermAdminAccess)).BindFunc(enforceIdempotency)

	// Catalog & metadata commands (public read + permissioned CRUD)
	group.GET("/roles", listRolesHandler)
	// The role EDITOR's list. Same rows, plus the configuration the public route no
	// longer carries — the permission matrix, system/custom, base role, mask limit.
	// Public /roles stays ungated on purpose (badges must render before sign-in),
	// so this is where the security model lives now.
	group.GET("/admin/roles", listAdminRolesHandler).BindFunc(RequirePermission(auth.PermManageRoles))
	group.POST("/roles", createRoleHandler).BindFunc(RequirePermission(auth.PermManageRoles)).BindFunc(enforceIdempotency)
	group.PATCH("/roles/{id}", updateRoleHandler).BindFunc(RequirePermission(auth.PermManageRoles)).BindFunc(enforceIdempotency)
	group.DELETE("/roles/{id}", deleteRoleHandler).BindFunc(RequirePermission(auth.PermManageRoles)).BindFunc(enforceIdempotency)

	group.GET("/designs", listDesignsHandler)
	group.GET("/designs/{id}", getDesignHandler)
	group.POST("/designs", createDesignHandler).BindFunc(RequirePermission(auth.PermManageDesigns)).BindFunc(enforceIdempotency)
	group.PATCH("/designs/{id}", updateDesignHandler).BindFunc(RequirePermission(auth.PermManageDesigns)).BindFunc(enforceIdempotency)
	group.DELETE("/designs/{id}", deleteDesignHandler).BindFunc(RequirePermission(auth.PermManageDesigns)).BindFunc(enforceIdempotency)

	group.GET("/category-groups", listCategoryGroupsHandler)
	group.POST("/category-groups", createCategoryGroupHandler).BindFunc(RequirePermission(auth.PermManageCategories)).BindFunc(enforceIdempotency)
	group.PATCH("/category-groups/{id}", updateCategoryGroupHandler).BindFunc(RequirePermission(auth.PermManageCategories)).BindFunc(enforceIdempotency)
	group.DELETE("/category-groups/{id}", deleteCategoryGroupHandler).BindFunc(RequirePermission(auth.PermManageCategories)).BindFunc(enforceIdempotency)

	// Categories
	group.GET("/categories", listCategoriesHandler)
	// The editor's view of the same rows, and the only response that carries
	// `allowed_roles`. Gated on the permission to change a category, because
	// that list is the permission model of the board.
	group.GET("/admin/categories", listAdminCategoriesHandler).BindFunc(RequirePermission(auth.PermManageCategories))
	// The forum index: categories AND the groups they are filed under, in one
	// response, because the screen cannot render without both.
	group.GET("/forum-index", listForumIndexHandler)
	// Forum-wide totals for the stats panel. Counted on read rather than cached —
	// see listForumStatsHandler.
	group.GET("/forum-stats", listForumStatsHandler)
	group.POST("/categories", createCategoryHandler).BindFunc(RequirePermission(auth.PermManageCategories)).BindFunc(enforceIdempotency)
	group.PATCH("/categories/{id}", updateCategoryHandler).BindFunc(RequirePermission(auth.PermManageCategories)).BindFunc(enforceIdempotency)
	group.DELETE("/categories/{id}", deleteCategoryHandler).BindFunc(RequirePermission(auth.PermManageCategories)).BindFunc(enforceIdempotency)

	// The public profile DTO and the public member board. The browser used to
	// read the `users` table through the SDK, which handed a signed-out visitor
	// the whole auth record — private `settings` included. See user_profile.go.
	group.GET("/users", listUsersHandler)
	group.GET("/users/search", searchUsersHandler)
	group.GET("/nicknames/check", checkNicknameHandler)
	group.GET("/users/{id}", getUserProfileHandler)
	// Characters (masks). Reads follow the users profile visibility rule;
	// writes are owner-only and self-service (ADR-5).
	group.GET("/users/{id}/characters", listUserCharactersHandler)
	// The profile's Posts tab. It used to read `posts` through the browser SDK,
	// which lockBrowserRules answers with 403 for every non-superuser — see
	// user_posts.go.
	group.GET("/users/{id}/posts", listUserPostsHandler)
	group.GET("/characters/{id}", getCharacterHandler)
	group.POST("/me/characters", createCharacterHandler).BindFunc(enforceIdempotency)
	group.PATCH("/characters/{id}", updateCharacterHandler).BindFunc(enforceIdempotency)
	group.DELETE("/characters/{id}", deleteCharacterHandler).BindFunc(enforceIdempotency)
	// No enforceIdempotency: multipart upload, same documented deviation as
	// PUT /me/avatar (ADR-4, avatar_upload.go header).
	group.PUT("/characters/{id}/avatar", uploadCharacterAvatarHandler)

	// Presence. One heartbeat route serves both identities: an authenticated
	// beat refreshes the in-process member map, an anonymous one upserts a
	// guest_presence row. Guests leave through a POST (navigator.sendBeacon
	// can only POST) and read the public counter through GET /presence/guests.
	group.POST("/presence/heartbeat", heartbeatHandler)
	group.POST("/presence/guest/leave", guestLeaveHandler)
	// The member counterpart of the guest leave. Without it a signed-in account
	// can only stop beating, which leaves it in the online list for the whole
	// presenceTTL — see memberLeaveHandler.
	group.POST("/presence/leave", memberLeaveHandler)
	group.GET("/presence/guests", listGuestsHandler)
	group.GET("/presence/online-users", listOnlineUsersHandler)

	// Sprint 3 forum command layer.
	group.POST("/topics", createTopicHandler).BindFunc(RequirePermission(auth.PermCreateTopic)).BindFunc(enforceIdempotency)
	group.GET("/topics", listTopicsHandler)
	group.GET("/topics/{id}", getTopicHandler)
	group.PATCH("/topics/{id}", updateTopicHandler).BindFunc(enforceIdempotency)
	group.POST("/topics/{id}/move", moveTopicHandler).BindFunc(RequirePermission(auth.PermMoveTopics)).BindFunc(enforceIdempotency)
	group.DELETE("/topics/{id}", deleteTopicHandler).BindFunc(enforceIdempotency)

	group.POST("/topics/{id}/posts", createPostHandler).BindFunc(RequirePermission(auth.PermPostReply)).BindFunc(enforceIdempotency)
	group.GET("/topics/{id}/posts", listPostsHandler)
	group.GET("/posts/{id}", getPostHandler)
	group.PATCH("/posts/{id}", editPostHandler).BindFunc(enforceIdempotency)
	group.DELETE("/posts/{id}", deletePostHandler).BindFunc(enforceIdempotency)
	group.POST("/topics/{id}/posts/move", movePostsHandler).BindFunc(RequirePermission(auth.PermMoveTopics)).BindFunc(enforceIdempotency)

	// Draft posts (drafts page + in-topic editing).
	//
	// The WRITE routes carry PermPostReply, the same key POST /topics/{id}/posts
	// demands. A draft is a reply that has not been sent yet, so gating it on
	// anything weaker means the reply gate is bypassable: these routes used to
	// be bound with enforceIdempotency alone, which consults neither the role nor
	// the status, and an account narrowed to nothing — banned, or pending — could
	// draft and then publish straight into the live forum.
	group.GET("/me/drafts", listMyDraftsHandler)
	group.GET("/topics/{id}/draft", getDraftHandler)
	group.PUT("/topics/{id}/draft", upsertDraftHandler).
		BindFunc(RequirePermission(auth.PermPostReply)).BindFunc(enforceIdempotency)
	// Deleting one's own draft grants nothing, so it stays ungated: a banned
	// account tidying up its unsent text is harmless.
	group.DELETE("/drafts/{id}", deleteDraftHandler).BindFunc(enforceIdempotency)
	group.POST("/drafts/{id}/publish", publishDraftHandler).
		BindFunc(RequirePermission(auth.PermPostReply)).BindFunc(enforceIdempotency)

	// Sprint 4 reputation, subscriptions and audit routes.
	group.GET("/admin/audit-logs", adminListAuditLogsHandler).BindFunc(RequirePermission(auth.PermViewAuditLog))

	group.POST("/topics/{id}/subscribe", subscribeTopicHandler).BindFunc(enforceIdempotency)
	group.POST("/topics/{id}/unsubscribe", unsubscribeTopicHandler).BindFunc(enforceIdempotency)
	group.DELETE("/topics/{id}/subscription", unsubscribeTopicHandler).BindFunc(enforceIdempotency)
	group.GET("/topics/{id}/subscription", getTopicSubscriptionStatusHandler)
	group.GET("/me/subscriptions", listUserSubscriptionsHandler)
	// Read state. These carry no enforceIdempotency: they write exactly one row
	// keyed (user, topic) and repeat to the same value, so an idempotency key
	// would only add a way for "I opened a topic" to fail.
	group.POST("/topics/{id}/read", markTopicReadHandler)
	group.POST("/me/topics/read-all", markAllTopicsReadHandler)

	group.POST("/posts/{id}/vote", votePostHandler).BindFunc(RequirePermission(auth.PermUseReputation)).BindFunc(enforceIdempotency)
	group.DELETE("/posts/{id}/vote", deletePostVoteHandler).BindFunc(RequirePermission(auth.PermUseReputation)).BindFunc(enforceIdempotency)
	group.POST("/users/{id}/vote", voteUserHandler).BindFunc(RequirePermission(auth.PermUseReputation)).BindFunc(enforceIdempotency)
	group.DELETE("/users/{id}/vote", deleteUserVoteHandler).BindFunc(RequirePermission(auth.PermUseReputation)).BindFunc(enforceIdempotency)
	// Reputation edit and delete are gated ONLY on use_reputation here, and the
	// per-action decision is made inside the handlers.
	//
	// That is a deliberate inversion of the previous shape. The route used to
	// require `delete_reputation`, a staff-only key, which meant a player could not
	// retract their own entry even when that was the only entry they were entitled
	// to touch. Ownership is a property of the RECORD, and the record is loaded
	// inside the command — a route-level check would have to guess which of the
	// four keys applies before it has read `voter_id`, and guessing there means
	// either locking members out or letting them through.
	group.PUT("/reputation/{id}", editReputationHandler).BindFunc(RequirePermission(auth.PermUseReputation)).BindFunc(enforceIdempotency)
	group.DELETE("/reputation/{id}", deleteReputationHandler).BindFunc(RequirePermission(auth.PermUseReputation)).BindFunc(enforceIdempotency)
	group.GET("/posts/{id}/voters", getPostVotersHandler)
	group.GET("/users/{id}/reputation", getUserReputationLogsHandler)
	// The caller's OWN votes. The browser used to read `reputation_votes`
	// directly over the PocketBase SDK, which that collection's nil browser
	// rules (migration 1766300000) refuse with 403 — see listMyVotesHandler.
	group.GET("/me/votes", listMyVotesHandler)

	// Sprint 5 direct messages, notifications and outbox routes.
	group.POST("/dms", createDMHandler).BindFunc(RequirePermission(auth.PermUseDirectMessages)).BindFunc(enforceIdempotency)
	group.GET("/dms", listConversationsHandler)
	// Under its own resource root rather than /dms/peer/{peerId}: the router rejects
	// that shape outright, because /dms/peer/{peerId} and /dms/{id}/messages both
	// match /dms/peer/messages and neither is more specific.
	group.GET("/conversations/peer/{peerId}", findConversationWithPeerHandler).BindFunc(RequirePermission(auth.PermUseDirectMessages))
	// The DM header's view of the correspondent: a nickname, an avatar and whether
	// the account may still be written to. Deliberately NOT /users/{id}, which is
	// the profile page and carries a member's `settings` — see getPeerCardHandler.
	group.GET("/peers/{id}", getPeerCardHandler)
	group.POST("/dms/{id}/messages", sendDMMessageHandler).BindFunc(RequirePermission(auth.PermUseDirectMessages)).BindFunc(enforceIdempotency)
	group.GET("/dms/{id}/messages", listDMMessagesHandler)
	group.POST("/dms/{id}/read", markConversationReadHandler)
	group.POST("/dms/{id}/clear", clearConversationHandler)
	// Message lifecycle. No RequirePermission: authority here is MEMBERSHIP and
	// authorship, both checked in the handler, because `edit_others_posts` must
	// not extend into a private conversation.
	group.PATCH("/dm-messages/{id}", editDMMessageHandler).BindFunc(enforceIdempotency)
	group.DELETE("/dm-messages/{id}", deleteDMMessageHandler).BindFunc(enforceIdempotency)

	group.GET("/me/notifications", listUserNotificationsHandler)
	group.PATCH("/me/notifications/{id}/read", markNotificationReadHandler)
	group.POST("/me/notifications/read-all", markAllNotificationsReadHandler)
	group.POST("/me/notifications/archive-all", archiveAllNotificationsHandler)
	group.PATCH("/me/notifications/{id}/archive", archiveNotificationHandler)
	group.GET("/me/unread-counts", getUnreadCountsHandler)

	group.GET("/admin/outbox-events", adminListOutboxEventsHandler).BindFunc(RequirePermission(auth.PermViewAuditLog))
	group.POST("/admin/outbox-events/{id}/retry", adminRetryOutboxEventHandler).BindFunc(RequirePermission(auth.PermViewAuditLog))

	// Admin email template management (plan step 5).
	group.GET("/admin/email-templates", getEmailTemplatesHandler).BindFunc(RequirePermission(auth.PermAdminAccess))
	group.PUT("/admin/email-templates", putEmailTemplatesHandler).BindFunc(RequirePermission(auth.PermAdminAccess)).BindFunc(enforceIdempotency)
	group.POST("/admin/email-templates/test", testEmailTemplatesHandler).BindFunc(RequirePermission(auth.PermAdminAccess)).BindFunc(enforceIdempotency)
}
