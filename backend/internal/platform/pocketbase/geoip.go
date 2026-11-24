package pocketbase

import (
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"

	"github.com/oschwald/geoip2-golang"
)

var (
	geoIPOnce   sync.Once
	geoIPReader *geoip2.Reader
)

// defaultGeoIPPaths lists places we look for the GeoLite2-City mmdb file.
var defaultGeoIPPaths = []string{
	"pb_data/geoip/GeoLite2-City.mmdb",
	"backend/pb_data/geoip/GeoLite2-City.mmdb",
	"../pb_data/geoip/GeoLite2-City.mmdb",
}

// initGeoIP attempts to open the MaxMind GeoLite2-City database.
// If the database is missing or unreadable, it fails safely without halting the server.
func initGeoIP() {
	customPath := os.Getenv("AERUN_GEOIP_PATH")
	var paths []string
	if customPath != "" {
		paths = append([]string{customPath}, defaultGeoIPPaths...)
	} else {
		paths = defaultGeoIPPaths
	}

	for _, p := range paths {
		clean := filepath.Clean(p)
		if info, err := os.Stat(clean); err == nil && !info.IsDir() {
			db, err := geoip2.Open(clean)
			if err == nil {
				geoIPReader = db
				slog.Info("GeoIP database loaded successfully", "path", clean)
				return
			}
			slog.Warn("Failed to open GeoIP database file", "path", clean, "error", err)
		}
	}

	slog.Info("GeoLite2-City.mmdb not found; GeoIP resolution will fallback to XX/Unknown")
}

// ResolveLocation maps an IP address string to (countryCode, cityName).
// If the IP is loopback, private, invalid, or the DB is unavailable, returns ("XX", "Unknown").
func ResolveLocation(ipStr string) (string, string) {
	parsedIP := net.ParseIP(ipStr)
	if parsedIP == nil {
		return "XX", "Unknown"
	}

	if parsedIP.IsLoopback() || parsedIP.IsPrivate() || parsedIP.IsUnspecified() {
		return "XX", "Local Network"
	}

	geoIPOnce.Do(initGeoIP)
	if geoIPReader == nil {
		return "XX", "Unknown"
	}

	record, err := geoIPReader.City(parsedIP)
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
	if geoIPReader != nil {
		_ = geoIPReader.Close()
		geoIPReader = nil
	}
}
