package main

import (
	"log/slog"
	"os"

	"github.com/SiJunma/aerun/backend/internal/config"
	_ "github.com/SiJunma/aerun/backend/internal/migrations"
	pb "github.com/SiJunma/aerun/backend/internal/platform/pocketbase"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	// Environment is the single configuration source; PB command-line flags must
	// not bypass validation of listener, origins, data directory or encryption.
	if len(os.Args) != 1 {
		logger.Error("startup rejected", "reason", "use environment configuration; command-line arguments are not supported")
		os.Exit(1)
	}
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	if err := pb.Run(cfg, logger); err != nil {
		logger.Error("backend stopped", "error", err)
		os.Exit(1)
	}
}
