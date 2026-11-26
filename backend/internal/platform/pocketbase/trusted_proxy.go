package pocketbase

import (
	"fmt"
	"slices"

	"github.com/pocketbase/pocketbase/core"
)

// trustedProxyHeaders is the fixed proxy chain in front of PocketBase:
//
//	browser -> Cloudflare edge -> Caddy (reverse proxy) -> PocketBase on AERUN_LISTEN
//
// PocketBase's RequestEvent.RealIP() ignores proxy headers unless they are
// listed in Settings.TrustedProxy — without this, it falls back to the direct
// TCP peer, which behind Caddy is always 127.0.0.1. That is why every visit
// recorded on production showed ip 127.0.0.1 and GeoIP returned XX / Local
// Network for real visitors (observed 2026-11-25): the telemetry handler,
// the IP-ban checks, the presence guest limiter and the auth rate limiter all
// read e.RealIP().
//
//   - CF-Connecting-IP first: Cloudflare overwrites it with the real visitor
//     IP, so it cannot be spoofed through the edge, and it is a single value
//     rather than a chain.
//   - X-Forwarded-For as fallback (direct-to-Caddy, no Cloudflare): Caddy
//     appends the real peer IP last, so the RIGHTMOST entry is the client.
//     UseLeftmostIP stays false on purpose — PocketBase's own warning on
//     TrustedProxyConfig says the leftmost entry can be a client-supplied
//     prefix the proxy merely appended to.
//
// The trust holds only because AERUN_LISTEN is loopback-only
// (config.Validate rejects anything else), so only Caddy can connect — the
// same model as the X-Forwarded-Proto check in guest_principal.go. On the
// local dev stack no proxy headers are present, so RealIP() still falls back
// to RemoteIP (127.0.0.1) and local visits correctly show Local Network.
var trustedProxyHeaders = []string{"CF-Connecting-IP", "X-Forwarded-For"}

// configureTrustedProxy reconciles Settings.TrustedProxy with the fixed proxy
// chain above on every boot, the same way configureOAuth2 and configureSMTP
// reconcile deployment-owned settings. It is a no-op when the stored config
// already matches, so a restart writes nothing.
func configureTrustedProxy(app core.App) error {
	settings := app.Settings()
	if slices.Equal(settings.TrustedProxy.Headers, trustedProxyHeaders) &&
		settings.TrustedProxy.UseLeftmostIP == false {
		return nil
	}
	settings.TrustedProxy = core.TrustedProxyConfig{
		Headers:       slices.Clone(trustedProxyHeaders),
		UseLeftmostIP: false,
	}
	if err := app.Save(settings); err != nil {
		return fmt.Errorf("save trusted proxy settings: %w", err)
	}
	app.Logger().Info("trusted proxy headers reconciled", "headers", trustedProxyHeaders)
	return nil
}
