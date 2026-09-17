package pocketbase

import (
	"log/slog"
	"os"
	"testing"

	"github.com/SiJunma/aerun/backend/internal/config"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, nil))
}

func TestRunRejectsProductionWithoutEncryptionKeyBeforeServe(t *testing.T) {
	err := Run(config.Config{
		Environment: "production",
		Listen:      "127.0.0.1:8090",
		DataDir:     "/tmp/pb_test",
		PublicURL:   "https://aerun.example.com",
		Origins:     []string{"https://aerun.example.com"},
	}, discardLogger())
	if err == nil {
		t.Fatal("expected production without AERUN_ENCRYPTION_KEY to be rejected, got nil")
	}
}
