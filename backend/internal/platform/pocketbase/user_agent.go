package pocketbase

import (
	"strings"
)

var botSignatures = []string{
	"googlebot", "bingbot", "yandexbot", "baiduspider", "duckduckbot",
	"applebot", "facebookexternalhit", "telegrambot", "discordbot",
	"twitterbot", "petalbot", "ahrefsbot", "semrushbot", "mj12bot",
	"dotbot", "crawler", "spider", "robot", "bot/", "curl", "wget",
	"python-requests", "go-http-client", "postmanruntime",
}

// UserAgentInfo represents structured metadata parsed from a User-Agent string.
type UserAgentInfo struct {
	Device  string
	Browser string
	OS      string
	IsBot   bool
}

// ParseUserAgent extracts device, browser, OS, and bot detection from a User-Agent string.
func ParseUserAgent(ua string) UserAgentInfo {
	if ua == "" {
		return UserAgentInfo{
			Device:  "desktop",
			Browser: "Other",
			OS:      "Other",
			IsBot:   false,
		}
	}

	lower := strings.ToLower(ua)

	// Bot check
	isBot := false
	for _, sig := range botSignatures {
		if strings.Contains(lower, sig) {
			isBot = true
			break
		}
	}

	// OS detection
	os := "Other"
	switch {
	case strings.Contains(ua, "Windows NT") || strings.Contains(ua, "Windows"):
		os = "Windows"
	case strings.Contains(ua, "Android"):
		os = "Android"
	case strings.Contains(ua, "iPhone") || strings.Contains(ua, "iPad") || strings.Contains(ua, "iPod") || strings.Contains(ua, "CPU OS "):
		os = "iOS"
	case strings.Contains(ua, "Mac OS X") || strings.Contains(ua, "Macintosh"):
		os = "macOS"
	case strings.Contains(ua, "Linux") || strings.Contains(ua, "X11"):
		os = "Linux"
	}

	// Device detection
	device := "desktop"
	switch {
	case isBot:
		device = "bot"
	case strings.Contains(lower, "ipad") || strings.Contains(lower, "tablet") || (strings.Contains(lower, "android") && !strings.Contains(lower, "mobile")):
		device = "tablet"
	case strings.Contains(lower, "mobile") || strings.Contains(lower, "iphone") || strings.Contains(lower, "ipod"):
		device = "mobile"
	}

	// Browser detection
	browser := "Other"
	switch {
	case isBot:
		browser = "Bot"
	case strings.Contains(ua, "Edg/") || strings.Contains(ua, "Edge/"):
		browser = "Edge"
	case strings.Contains(ua, "OPR/") || strings.Contains(ua, "Opera/"):
		browser = "Opera"
	case strings.Contains(ua, "Chrome/") || strings.Contains(ua, "CriOS/"):
		browser = "Chrome"
	case strings.Contains(ua, "Firefox/") || strings.Contains(ua, "FxiOS/"):
		browser = "Firefox"
	case strings.Contains(ua, "Safari/") && !strings.Contains(ua, "Chrome") && !strings.Contains(ua, "CriOS"):
		browser = "Safari"
	}

	return UserAgentInfo{
		Device:  device,
		Browser: browser,
		OS:      os,
		IsBot:   isBot,
	}
}
