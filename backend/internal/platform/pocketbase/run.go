package pocketbase

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

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
		DefaultDataDir:  cfg.DataDir,
		HideStartBanner: true,
	})

	pb.OnServe().BindFunc(func(se *core.ServeEvent) error {
		if allow := strings.Join(cfg.Origins, ","); allow != "" {
			se.Router.Bind(apis.WrapStdMiddleware(corsAllowList(allow)))
		}
		registerRoutes(se, cfg)
		return se.Next()
	})

	pb.OnBootstrap().BindFunc(func(e *core.BootstrapEvent) error {
		if err := e.Next(); err != nil {
			return err
		}
		settings := pb.Settings()
		settings.Meta.AppName = "Aerun"
		settings.Meta.AppURL = cfg.PublicURL
		settings.Meta.SenderAddress = "no-reply@aerun.invalid"
		settings.Meta.SenderName = "Aerun"
		return pb.Save(settings)
	})

	serveErr := make(chan error, 1)
	go func() { serveErr <- pb.Start() }()

	select {
	case err := <-serveErr:
		return err
	case <-time.After(startupTimeout):
	}
	// pocketbase.New() serves on its built-in default 127.0.0.1:8090; explicit
	// listener/origin binding is finalized in the next sprint review (README).
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
	// The host keeps running for manual inspection; logs carry the failure cause.
	return fmt.Errorf("health check failed after %s at %s: %w", startupTimeout, url, lastErr)
}

func registerRoutes(se *core.ServeEvent, cfg config.Config) {
	se.Router.GET(healthPath, func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, map[string]any{
			"status":      "ok",
			"service":     "aerun-backend",
			"environment": cfg.Environment,
		})
	})
}

// corsAllowList sets a comma-joined origin allowlist header. A permissive
// "*" value is filtered out during configuration loading and never reaches
// the wire.
func corsAllowList(allow string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if allow != "" {
				w.Header().Set("Access-Control-Allow-Origin", allow)
				w.Header().Set("Vary", "Origin")
			}
			next.ServeHTTP(w, r)
		})
	}
}
