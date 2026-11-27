package pocketbase

// PWA icon upload for forum_settings (PUT /api/aerun/admin/settings/pwa-icon/{kind}).
//
// Follows the same storage split as the favicon and the identity
// placeholders:
//   - uploaded bytes are stored on the record's single-select FileField
//     (Protected=false so every visitor can load it from /api/files/...);
//   - the matching `pwa_icon_*_url` text field is rewritten to the
//     host-agnostic `/api/files/...` path, which is what the dynamic
//     manifest serves.
//
// Deliberately NOT bound to enforceIdempotency (same reasoning as
// /admin/settings/favicon): the idempotency middleware caps buffered bodies
// at 512 KB, whereas multipart uploads allow up to 2 MB, and overwriting a
// single-select FileField is a converging replace.

import (
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// pwaIconSpec maps an upload kind to its FileField, URL field and file prefix.
type pwaIconSpec struct {
	fileField string
	urlField  string
	prefix    string
}

var pwaIconSpecs = map[string]pwaIconSpec{
	"icon-192":      {fileField: "pwa_icon_192", urlField: "pwa_icon_192_url", prefix: "pwa-icon-192"},
	"icon-512":      {fileField: "pwa_icon_512", urlField: "pwa_icon_512_url", prefix: "pwa-icon-512"},
	"icon-maskable": {fileField: "pwa_icon_maskable", urlField: "pwa_icon_maskable_url", prefix: "pwa-icon-maskable"},
	"apple-touch":   {fileField: "pwa_icon_apple_touch", urlField: "pwa_icon_apple_touch_url", prefix: "pwa-icon-apple-touch"},
	"badge":         {fileField: "pwa_icon_badge", urlField: "pwa_icon_badge_url", prefix: "pwa-icon-badge"},
}

// uploadPWAIconHandler serves PUT /api/aerun/admin/settings/pwa-icon/{kind}.
func uploadPWAIconHandler(e *core.RequestEvent) error {
	acc := AccessFrom(e)
	if !auth.Has(acc.Permissions, auth.PermAdminAccess) {
		return router.NewForbiddenError("only an administrator may change the PWA icons", nil)
	}

	kind := strings.TrimSpace(e.Request.PathValue("kind"))
	spec, ok := pwaIconSpecs[kind]
	if !ok {
		return validationError("unknown pwa icon kind")
	}

	record, err := e.App.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		return internalError("forum settings row is missing", err)
	}

	// Raster images only: a manifest icon must be a PNG/JPEG/WebP the
	// browser can install. ICO and SVG are rejected — avatarExtension
	// returns ".bin" for anything it does not recognise.
	data, err := readImageUpload(e, "pwa icon")
	if err != nil {
		return err
	}
	ext := avatarExtension(data)
	if ext == ".bin" {
		return validationError("pwa icon must be a PNG, JPEG, WebP or GIF image")
	}

	file, err := filesystem.NewFileFromBytes(data, spec.prefix+ext)
	if err != nil {
		return internalError("failed to read the uploaded pwa icon", err)
	}

	record.Set(spec.fileField, file)
	record.Set("updated_at", time.Now())
	if err := e.App.Save(record); err != nil {
		return internalError("failed to store the pwa icon", err)
	}

	record.Set(spec.urlField, AvatarFilePath(record.Collection().Id, record.Id, record.GetString(spec.fileField)))
	if err := e.App.Save(record); err != nil {
		return internalError("failed to update the pwa icon reference", err)
	}

	_ = recordAuditLog(e.App, "settings_updated", e.Auth.Id, map[string]any{
		"keys": []string{spec.fileField},
	})

	return e.JSON(http.StatusOK, map[string]any{
		"kind":       kind,
		"icon_url":   record.GetString(spec.urlField),
		"request_id": requestIDFrom(e),
	})
}
