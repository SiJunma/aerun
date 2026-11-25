package pocketbase

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/oschwald/geoip2-golang"
	"github.com/pocketbase/pocketbase/core"
)

var (
	geoIPMu          sync.RWMutex
	geoIPInitialized bool
	geoIPDataDir     string
	geoIPReader      *geoip2.Reader

	// geoIPDownloadBaseURL can be overridden in tests to point at an httptest.Server.
	geoIPDownloadBaseURL = "https://download.maxmind.com/app/geoip_download"
)

const maxGeoIPArchiveBytes = 256 << 20 // 256 MiB safety cap

// defaultGeoIPPaths lists fallback places we look for the GeoLite2-City mmdb file.
var defaultGeoIPPaths = []string{
	"pb_data/geoip/GeoLite2-City.mmdb",
	"backend/pb_data/geoip/GeoLite2-City.mmdb",
	"../pb_data/geoip/GeoLite2-City.mmdb",
}

func setGeoIPDataDir(dataDir string) {
	geoIPMu.Lock()
	geoIPDataDir = strings.TrimSpace(dataDir)
	geoIPInitialized = false
	geoIPMu.Unlock()
}

func geoIPTargetPath(dataDir string) string {
	cleanDir := strings.TrimSpace(dataDir)
	if cleanDir != "" {
		return filepath.Join(cleanDir, "geoip", "GeoLite2-City.mmdb")
	}
	return filepath.Join("pb_data", "geoip", "GeoLite2-City.mmdb")
}

func geoIPCandidatePaths(dataDir string) []string {
	var paths []string
	if customPath := strings.TrimSpace(os.Getenv("AERUN_GEOIP_PATH")); customPath != "" {
		paths = append(paths, customPath)
	}
	if strings.TrimSpace(dataDir) != "" {
		paths = append(paths, geoIPTargetPath(dataDir))
	}
	paths = append(paths, defaultGeoIPPaths...)
	return paths
}

func geoIPDatabaseExists(dataDir string) bool {
	for _, p := range geoIPCandidatePaths(dataDir) {
		clean := filepath.Clean(p)
		if info, err := os.Stat(clean); err == nil && !info.IsDir() && info.Size() > 0 {
			return true
		}
	}
	return false
}

// initGeoIPLocked attempts to open the MaxMind GeoLite2-City database.
// Caller must hold geoIPMu write lock.
func initGeoIPLocked(dataDir string) {
	geoIPInitialized = true
	for _, p := range geoIPCandidatePaths(dataDir) {
		clean := filepath.Clean(p)
		if info, err := os.Stat(clean); err == nil && !info.IsDir() {
			db, err := geoip2.Open(clean)
			if err == nil {
				if geoIPReader != nil {
					_ = geoIPReader.Close()
				}
				geoIPReader = db
				slog.Info("GeoIP database loaded successfully", "path", clean)
				return
			}
			slog.Warn("Failed to open GeoIP database file", "path", clean, "error", err)
		}
	}
	slog.Info("GeoLite2-City.mmdb not found; GeoIP resolution will fallback to XX/Unknown")
}

// reloadGeoIP closes any open reader and loads the database from disk.
func reloadGeoIP(dataDir string) error {
	geoIPMu.Lock()
	defer geoIPMu.Unlock()
	if strings.TrimSpace(dataDir) != "" {
		geoIPDataDir = strings.TrimSpace(dataDir)
	}
	initGeoIPLocked(geoIPDataDir)
	if geoIPReader == nil {
		return errors.New("GeoIP database file could not be loaded")
	}
	return nil
}

// ResolveLocation maps an IP address string to (countryCode, cityName).
// If the IP is loopback, private, invalid, or the DB is unavailable, returns ("XX", "Unknown").
func ResolveLocation(ipStr string) (string, string) {
	parsedIP := net.ParseIP(strings.TrimSpace(ipStr))
	if parsedIP == nil {
		return "XX", "Unknown"
	}

	if parsedIP.IsLoopback() || parsedIP.IsPrivate() || parsedIP.IsUnspecified() {
		return "XX", "Local Network"
	}

	geoIPMu.RLock()
	initialized := geoIPInitialized
	reader := geoIPReader
	geoIPMu.RUnlock()

	if !initialized {
		geoIPMu.Lock()
		if !geoIPInitialized {
			initGeoIPLocked(geoIPDataDir)
		}
		reader = geoIPReader
		geoIPMu.Unlock()
	}

	if reader == nil {
		return "XX", "Unknown"
	}

	geoIPMu.RLock()
	record, err := geoIPReader.City(parsedIP)
	geoIPMu.RUnlock()
	if err != nil {
		return "XX", "Unknown"
	}

	countryCode := record.Country.IsoCode
	if countryCode == "" {
		countryCode = "XX"
	}

	cityName := record.City.Names["en"]
	if cityName == "" {
		cityName = "Unknown"
	}

	return countryCode, cityName
}

// CloseGeoIP closes the GeoIP database reader if open.
func CloseGeoIP() {
	geoIPMu.Lock()
	defer geoIPMu.Unlock()
	if geoIPReader != nil {
		_ = geoIPReader.Close()
		geoIPReader = nil
	}
	geoIPInitialized = false
}

// downloadGeoLite2City fetches the MaxMind GeoLite2-City tar.gz archive using the
// provided license key, extracts the .mmdb file, verifies it opens cleanly, atomically
// writes it into <dataDir>/geoip/GeoLite2-City.mmdb, and reloads the reader.
// Errors never include the license key.
func downloadGeoLite2City(app core.App, licenseKey string) (string, error) {
	cleanKey := strings.TrimSpace(licenseKey)
	if cleanKey == "" {
		return "", errors.New("MaxMind license key is empty")
	}

	dlURL := fmt.Sprintf(
		"%s?edition_id=GeoLite2-City&license_key=%s&suffix=tar.gz",
		strings.TrimRight(geoIPDownloadBaseURL, "/"),
		url.QueryEscape(cleanKey),
	)

	client := &http.Client{Timeout: 60 * time.Second}
	req, err := http.NewRequest(http.MethodGet, dlURL, nil)
	if err != nil {
		return "", errors.New("failed to build MaxMind download request")
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", errors.New("failed to reach MaxMind download server")
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return "", fmt.Errorf("MaxMind rejected license key (HTTP %d)", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("MaxMind download failed with HTTP %d", resp.StatusCode)
	}

	limited := io.LimitReader(resp.Body, maxGeoIPArchiveBytes)
	gzReader, err := gzip.NewReader(limited)
	if err != nil {
		return "", fmt.Errorf("invalid gzip archive from MaxMind: %w", err)
	}
	defer gzReader.Close()

	targetPath := geoIPTargetPath(app.DataDir())
	targetDir := filepath.Dir(targetPath)
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return "", fmt.Errorf("create geoip directory: %w", err)
	}

	tmpFile, err := os.CreateTemp(targetDir, "GeoLite2-City-*.mmdb.tmp")
	if err != nil {
		return "", fmt.Errorf("create temp mmdb file: %w", err)
	}
	tmpPath := tmpFile.Name()
	cleanupTmp := func() {
		_ = tmpFile.Close()
		_ = os.Remove(tmpPath)
	}

	tarReader := tar.NewReader(gzReader)
	foundMMDB := false
	for {
		hdr, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			cleanupTmp()
			return "", fmt.Errorf("read MaxMind tar archive: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		if strings.HasSuffix(strings.ToLower(hdr.Name), ".mmdb") {
			if _, err := io.Copy(tmpFile, io.LimitReader(tarReader, maxGeoIPArchiveBytes)); err != nil {
				cleanupTmp()
				return "", fmt.Errorf("extract mmdb from archive: %w", err)
			}
			foundMMDB = true
			break
		}
	}

	if !foundMMDB {
		cleanupTmp()
		return "", errors.New("no .mmdb file found in MaxMind archive")
	}

	if err := tmpFile.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return "", fmt.Errorf("close extracted mmdb: %w", err)
	}

	// Verify the extracted file is a valid MaxMind DB before swapping it into place.
	probe, err := geoip2.Open(tmpPath)
	if err != nil {
		_ = os.Remove(tmpPath)
		return "", fmt.Errorf("extracted file is not a valid GeoIP database: %w", err)
	}
	_ = probe.Close()

	// Close the current reader on Windows before renaming over the target file.
	CloseGeoIP()

	if err := os.Rename(tmpPath, targetPath); err != nil {
		_ = os.Remove(tmpPath)
		return "", fmt.Errorf("install GeoIP database: %w", err)
	}

	if err := reloadGeoIP(app.DataDir()); err != nil {
		return "", err
	}
	return targetPath, nil
}
