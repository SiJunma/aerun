// 1770000003_guest_principal_schema.go introduces the stable guest principal
// collection. A guest principal is the server-issued, cookie-bound identity
// that lets a guest own content across posts and be the target of reputation
// votes — without inventing an account. It is the building block for the
// future time-limited guest edit/delete capability (ADR: HttpOnly cookie +
// server-side hashed capability, nickname is never a credential).
//
// The collection is server-only: clients never write it directly. A principal
// is created through POST /api/aerun/guest/principal, which sets an HttpOnly
// cookie carrying `guest_id:secret`. The server stores only capability_hash
// (sha256 of the secret) and never the plaintext secret, so a compromised
// database cannot impersonate a guest. The cookie is not re-issued on every
// request: once set, subsequent creation attempts are no-ops, which pins the
// principal to the first browser that claimed it and prevents cookie
// fixation attacks.
//
// Rows are unbounded in lifetime by design (unlike guest_presence, which is
// pruned): a guest principal is the durable anchor for everything a guest
// writes, and pruning it would orphan content ownership.
package migrations

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

const (
	guestPrincipalCollectionTable = "guest_principals"
	guestPrincipalCookieName      = "aerun_guest_cap"
)

func init() {
	m.Register(createGuestPrincipalSchema, removeGuestPrincipalSchema)
}

func createGuestPrincipalSchema(app core.App) error {
	collection := core.NewBaseCollection(guestPrincipalCollectionTable)
	collection.Fields.Add(&core.TextField{
		Name:     "guest_id",
		Required: true,
		Max:      64,
	})
	collection.Fields.Add(&core.TextField{
		Name:     "capability_hash",
		Required: true,
		Max:      128,
	})
	collection.Fields.Add(&core.DateField{
		Name: "last_used_at",
	})
	if err := app.Save(collection); err != nil {
		return fmt.Errorf("save guest_principals collection: %w", err)
	}
	collection.AddIndex("idx_guest_principals_guest_id", true, "guest_id", "")
	return app.Save(collection)
}

func removeGuestPrincipalSchema(app core.App) error {
	collection, err := app.FindCollectionByNameOrId(guestPrincipalCollectionTable)
	if err != nil || collection == nil {
		return fmt.Errorf("find guest_principals collection: %w", err)
	}
	collection.RemoveIndex("idx_guest_principals_guest_id")
	collection.Fields.RemoveByName("guest_id")
	collection.Fields.RemoveByName("capability_hash")
	collection.Fields.RemoveByName("last_used_at")
	if err := app.Save(collection); err != nil {
		return fmt.Errorf("remove guest_principals schema: %w", err)
	}
	return nil
}

// hashCapability returns the sha256 hex digest of a guest capability secret.
// The digest is what gets persisted; the plaintext secret only ever lives in
// the HttpOnly cookie and in the client's memory.
func hashCapability(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}
