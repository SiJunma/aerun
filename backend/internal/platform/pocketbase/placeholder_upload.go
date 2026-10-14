package pocketbase

// Admin upload for the identity placeholder images (plan I5/D2).
//
// PUT /api/aerun/admin/settings/placeholder/{kind} stores one of the two custom
// placeholder avatars — "deleted" (shown for a removed account) or "guest"
// (shown for an anonymous visitor) — onto the forum_settings singleton and
// rewrites its *_avatar_url reference, exactly as the user-avatar command does
// for an account. Until an image is uploaded the reference stays empty and the
// frontend falls back to its neutral default (src/utils/identity.js).
//
// The route is gated on PermAdminAccess (see run.go) and, like the user-avatar
// command, is deliberately NOT bound to enforceIdempotency: that middleware
// buffers the whole body and caps it at 512 KB, which a multipart image can
// never satisfy. The write is safe without the envelope because it is a REPLACE
// — a single-select FileField is overwritten in place, so a retried upload
// converges on one stored file rather than stacking duplicates.
//
// The file is stored in a FileField with the default Protected=false, so
// PocketBase serves it publicly from /api/files/... without consulting the
// server-only ViewRule of forum_settings (see apis/file.go: the ViewRule is
// only checked for a protected file). That is correct: a placeholder avatar is
// forum chrome every visitor — including a guest — must be able to load, the
// same as the logo and the backgrounds.

import (
	"net/http"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// identityPlaceholderKinds maps the URL path segment onto the file field and
// the reference column it drives. An unknown kind is refused rather than
// silently defaulted, so a typo in the client cannot overwrite the wrong image.
var identityPlaceholderKinds = map[string]struct {
	fileField string
	urlField  string
}{
	"deleted": {fileField: "deleted_avatar", urlField: "deleted_avatar_url"},
	"guest":   {fileField: "guest_avatar", urlField: "guest_avatar_url"},
}

// uploadIdentityPlaceholderHandler stores an uploaded image as one of the two
// identity placeholder avatars on the settings singleton.
func uploadIdentityPlaceholderHandler(e *core.RequestEvent) error {
	kind := strings.TrimSpace(e.Request.PathValue("kind"))
	fields, ok := identityPlaceholderKinds[kind]
	if !ok {
		return validationError("placeholder kind must be \"deleted\" or \"guest\"")
	}

	// Defence in depth: the route already requires admin_access, but the handler
	// re-checks so the command is safe wherever it is mounted.
	acc := AccessFrom(e)
	if !auth.Has(acc.Permissions, auth.PermAdminAccess) {
		return router.NewForbiddenError("only an administrator may change placeholder images", nil)
	}

	record, err := e.App.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		return internalError("forum settings row is missing", err)
	}

	url, err := storeOwnedPlaceholder(e, record, fields.fileField, fields.urlField)
	if err != nil {
		return err
	}

	// Same audit trail as the settings command: name what changed, not its
	// bytes, so "who replaced the deleted placeholder" is one query away. The
	// performer is the caller's own auth id — AccessContext carries only role,
	// status and permissions, never the id.
	_ = recordAuditLog(e.App, "settings_updated", e.Auth.Id, map[string]any{
		"keys": []string{kind + "_avatar"},
	})

	return e.JSON(http.StatusOK, map[string]any{
		"kind":       kind,
		"avatar_url": url,
		"request_id": requestIDFrom(e),
	})
}

// storeOwnedPlaceholder writes the uploaded bytes onto the singleton's file
// field and returns the rewritten reference, reusing the same read/sniff/save
// path the user-avatar command uses. Two saves are unavoidable and are the
// same two-step that command performs: PocketBase assigns the stored file name
// during the first save, so the reference can only be built once it is known.
func storeOwnedPlaceholder(e *core.RequestEvent, record *core.Record, fileField, urlField string) (string, error) {
	data, err := readAvatarUpload(e)
	if err != nil {
		return "", err
	}

	name := avatarFileName(data)
	if name == avatarFilePrefix+".bin" {
		// The sniffer did not recognise the bytes, so the upload is not one of
		// the formats the field accepts. Saying so beats storing a file the
		// browser renders as a broken image.
		return "", validationError("placeholder must be a PNG, JPEG, WebP or GIF image")
	}

	file, err := filesystem.NewFileFromBytes(data, name)
	if err != nil {
		return "", internalError("failed to read the uploaded placeholder", err)
	}
	record.Set(fileField, file)
	if err := e.App.Save(record); err != nil {
		return "", internalError("failed to store the placeholder", err)
	}

	record.Set(urlField, AvatarFilePath(record.Collection().Id, record.Id, record.GetString(fileField)))
	if err := e.App.Save(record); err != nil {
		return "", internalError("failed to update the placeholder reference", err)
	}

	return record.GetString(urlField), nil
}
