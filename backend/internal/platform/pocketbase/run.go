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
		registerRoutes(se, cfg)
		return se.Next()
	})

	// Sprint 2 mail guardrail: intercept every outgoing email at the app
	// hook level before an SMTP connection or sendmail exec can happen.
	pb.OnMailerSend().BindFunc(MailHardDisableGuard())

	pb.OnBootstrap().BindFunc(func(e *core.BootstrapEvent) error {
		if err := e.Next(); err != nil {
			return err
		}
		settings := pb.Settings()
		settings.Meta.AppName = "Aerun"
		settings.Meta.AppURL = cfg.PublicURL
		settings.Meta.SenderAddress = "no-reply@aerun.invalid"
		settings.Meta.SenderName = "Aerun"
		// Defense in depth for the mail hard-disable: even if SMTP settings
		// were enabled in the dashboard, reset them on every startup. The
		// OnMailerSend guard above still blocks any send attempt.
		settings.SMTP.Enabled = false
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

	group.GET("/me", meHandler)
	group.PUT("/me/settings", updateSettingsHandler)
	// No enforceIdempotency: that middleware buffers the body and caps it at
	// 512 KB, which a multipart avatar can never satisfy (see avatar_upload.go).
	group.PUT("/me/avatar", uploadMyAvatarHandler)

	// Sprint 2 identity commands.
	group.POST("/auth/register", registerHandler)
	group.GET("/admin/users", adminListUsersHandler).BindFunc(RequirePermission(auth.PermAdminAccess))
	group.PATCH("/admin/users/{id}", adminUpdateUserHandler).BindFunc(RequirePermission(auth.PermAdminAccess)).BindFunc(enforceIdempotency)
	group.DELETE("/admin/users/{id}", adminDeleteUserHandler).BindFunc(RequirePermission(auth.PermAdminAccess)).BindFunc(enforceIdempotency)

	// Catalog & metadata commands (public read + permissioned CRUD)
	group.GET("/roles", listRolesHandler)
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
	group.POST("/categories", createCategoryHandler).BindFunc(RequirePermission(auth.PermManageCategories)).BindFunc(enforceIdempotency)
	group.PATCH("/categories/{id}", updateCategoryHandler).BindFunc(RequirePermission(auth.PermManageCategories)).BindFunc(enforceIdempotency)
	group.DELETE("/categories/{id}", deleteCategoryHandler).BindFunc(RequirePermission(auth.PermManageCategories)).BindFunc(enforceIdempotency)

	// Characters (masks). Reads follow the users profile visibility rule;
	// writes are owner-only and self-service (ADR-5).
	group.GET("/users/{id}/characters", listUserCharactersHandler)
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
	group.GET("/topics/{id}/posts/by-sequence/{sequence}", getPostBySequenceHandler)
	group.PATCH("/posts/{id}", editPostHandler).BindFunc(enforceIdempotency)
	group.DELETE("/posts/{id}", deletePostHandler).BindFunc(enforceIdempotency)
	group.POST("/topics/{id}/posts/move", movePostsHandler).BindFunc(RequirePermission(auth.PermMoveTopics)).BindFunc(enforceIdempotency)

	// Draft posts (drafts page + in-topic editing).
	group.GET("/me/drafts", listMyDraftsHandler)
	group.GET("/topics/{id}/draft", getDraftHandler)
	group.PUT("/topics/{id}/draft", upsertDraftHandler).BindFunc(enforceIdempotency)
	group.DELETE("/drafts/{id}", deleteDraftHandler).BindFunc(enforceIdempotency)
	group.POST("/drafts/{id}/publish", publishDraftHandler).BindFunc(enforceIdempotency)

	// Sprint 4 reputation, subscriptions and audit routes.
	group.GET("/admin/audit-logs", adminListAuditLogsHandler).BindFunc(RequirePermission(auth.PermViewAuditLog))

	group.POST("/topics/{id}/subscribe", subscribeTopicHandler).BindFunc(enforceIdempotency)
	group.POST("/topics/{id}/unsubscribe", unsubscribeTopicHandler).BindFunc(enforceIdempotency)
	group.DELETE("/topics/{id}/subscription", unsubscribeTopicHandler).BindFunc(enforceIdempotency)
	group.GET("/topics/{id}/subscription", getTopicSubscriptionStatusHandler)
	group.GET("/me/subscriptions", listUserSubscriptionsHandler)

	group.POST("/posts/{id}/vote", votePostHandler).BindFunc(RequirePermission(auth.PermUseReputation)).BindFunc(enforceIdempotency)
	group.DELETE("/posts/{id}/vote", deletePostVoteHandler).BindFunc(RequirePermission(auth.PermUseReputation)).BindFunc(enforceIdempotency)
	group.POST("/users/{id}/vote", voteUserHandler).BindFunc(RequirePermission(auth.PermUseReputation)).BindFunc(enforceIdempotency)
	group.DELETE("/users/{id}/vote", deleteUserVoteHandler).BindFunc(RequirePermission(auth.PermUseReputation)).BindFunc(enforceIdempotency)
	group.DELETE("/reputation/{id}", deleteReputationHandler).BindFunc(RequirePermission(auth.PermDeleteReputation)).BindFunc(enforceIdempotency)
	group.GET("/posts/{id}/voters", getPostVotersHandler)
	group.GET("/users/{id}/reputation", getUserReputationLogsHandler)

	// Sprint 5 direct messages, notifications and outbox routes.
	group.POST("/dms", createDMHandler).BindFunc(RequirePermission(auth.PermUseDirectMessages)).BindFunc(enforceIdempotency)
	group.GET("/dms", listConversationsHandler)
	group.POST("/dms/{id}/messages", sendDMMessageHandler).BindFunc(RequirePermission(auth.PermUseDirectMessages)).BindFunc(enforceIdempotency)
	group.GET("/dms/{id}/messages", listDMMessagesHandler)
	group.POST("/dms/{id}/read", markConversationReadHandler)
	group.POST("/dms/{id}/clear", clearConversationHandler)

	group.GET("/me/notifications", listUserNotificationsHandler)
	group.PATCH("/me/notifications/{id}/read", markNotificationReadHandler)
	group.POST("/me/notifications/read-all", markAllNotificationsReadHandler)
	group.PATCH("/me/notifications/{id}/archive", archiveNotificationHandler)
	group.GET("/me/unread-counts", getUnreadCountsHandler)

	group.GET("/admin/outbox-events", adminListOutboxEventsHandler).BindFunc(RequirePermission(auth.PermViewAuditLog))
	group.POST("/admin/outbox-events/{id}/retry", adminRetryOutboxEventHandler).BindFunc(RequirePermission(auth.PermViewAuditLog))
}
