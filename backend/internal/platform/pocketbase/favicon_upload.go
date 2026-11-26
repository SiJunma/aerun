package pocketbase

// Favicon upload for forum_settings (PUT /api/aerun/admin/settings/favicon)
// and custom designs (PUT /api/aerun/designs/{id}/favicon).
//
// Follows the same storage split as avatars and identity placeholders:
//   - uploaded bytes are stored on the record's single-select `favicon` FileField
//     (Protected=false so every visitor can load it from /api/files/...);
//   - `favicon_url` is rewritten to the host-agnostic `/api/files/...` path.
//
// Deliberately NOT bound to enforceIdempotency (same reasoning as /me/avatar
// and /admin/settings/placeholder/{kind}): the idempotency middleware caps
// buffered bodies at 512 KB, whereas multipart uploads allow up to 2 MB, and
// overwriting a single-select FileField is a converging replace.

import (
	"bytes"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

const (
	faviconFieldName    = "favicon"
	faviconURLFieldName = "favicon_url"
	faviconFilePrefix   = "favicon"
)

func faviconExtension(data []byte) string {
	if ext := avatarExtension(data); ext != ".bin" {
		return ext
	}
	// Windows ICO / CUR magic bytes (matches gabriel-vasile/mimetype magic.Ico).
	if len(data) >= 4 && data[0] == 0x00 && data[1] == 0x00 && (data[2] == 0x01 || data[2] == 0x02) && data[3] == 0x00 {
		return ".ico"
	}
	if isSVGPayload(data) {
		return ".svg"
	}
	return ".bin"
}

func isSVGPayload(data []byte) bool {
	head := data
	if len(head) > 4096 {
		head = head[:4096]
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return false
	}
	trimmed := strings.TrimSpace(string(head))
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "<svg") {
		return true
	}
	if strings.HasPrefix(lower, "<?xml") || strings.HasPrefix(lower, "<!--") {
		return strings.Contains(lower, "<svg")
	}
	return false
}

func storeOwnedFavicon(e *core.RequestEvent, record *core.Record, touchUpdatedAt bool) (string, error) {
	data, err := readImageUpload(e, "favicon")
	if err != nil {
		return "", err
	}

	ext := faviconExtension(data)
	if ext == ".bin" {
		return "", validationError("favicon must be a PNG, JPEG, WebP, GIF, ICO or SVG image")
	}

	file, err := filesystem.NewFileFromBytes(data, faviconFilePrefix+ext)
	if err != nil {
		return "", internalError("failed to read the uploaded favicon", err)
	}

	record.Set(faviconFieldName, file)
	if touchUpdatedAt {
		record.Set("updated_at", time.Now())
	}
	if err := e.App.Save(record); err != nil {
		return "", internalError("failed to store the favicon", err)
	}

	record.Set(faviconURLFieldName, AvatarFilePath(record.Collection().Id, record.Id, record.GetString(faviconFieldName)))
	if err := e.App.Save(record); err != nil {
		return "", internalError("failed to update the favicon reference", err)
	}

	return record.GetString(faviconURLFieldName), nil
}

// uploadSettingsFaviconHandler serves PUT /api/aerun/admin/settings/favicon.
func uploadSettingsFaviconHandler(e *core.RequestEvent) error {
	acc := AccessFrom(e)
	if !auth.Has(acc.Permissions, auth.PermAdminAccess) {
		return router.NewForbiddenError("only an administrator may change the forum favicon", nil)
	}

	record, err := e.App.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		return internalError("forum settings row is missing", err)
	}

	url, err := storeOwnedFavicon(e, record, false)
	if err != nil {
		return err
	}

	_ = recordAuditLog(e.App, "settings_updated", e.Auth.Id, map[string]any{
		"keys": []string{faviconFieldName},
	})

	return e.JSON(http.StatusOK, map[string]any{
		"favicon_url": url,
		"request_id":  requestIDFrom(e),
	})
}

// uploadDesignFaviconHandler serves PUT /api/aerun/designs/{id}/favicon.
func uploadDesignFaviconHandler(e *core.RequestEvent) error {
	acc := AccessFrom(e)
	if !auth.Has(acc.Permissions, auth.PermManageDesigns) {
		return router.NewForbiddenError("missing manage_designs permission", nil)
	}

	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return validationError("design id is required")
	}

	rec, err := e.App.FindRecordById(designsCollectionName, id)
	if err != nil || rec == nil {
		return notFoundError("design not found")
	}

	url, err := storeOwnedFavicon(e, rec, true)
	if err != nil {
		return err
	}

	_ = recordAuditLog(e.App, "design_updated", e.Auth.Id, map[string]any{
		"target_id":       rec.Id,
		"name":            rec.GetString("name"),
		"favicon_updated": true,
	})

	return e.JSON(http.StatusOK, map[string]any{
		"favicon_url": url,
		"design":      designRecordPayload(rec),
		"request_id":  requestIDFrom(e),
	})
}
