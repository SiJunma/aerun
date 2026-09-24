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

	group.GET("/me", meHandler)
	group.PUT("/me/settings", updateSettingsHandler)

	// Sprint 2 identity commands.
	group.POST("/auth/register", registerHandler)
	group.GET("/admin/users", adminListUsersHandler).BindFunc(RequirePermission(auth.PermAdminAccess))

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
}
