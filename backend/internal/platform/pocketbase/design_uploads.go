package pocketbase

// Card image uploads (PLAN_DESIGNS_TAB_SURFACES.md §4.2, §6).
//
//   - PUT /api/aerun/designs/{id}/background/{kind} and
//     PUT /api/aerun/default-designs/{key}/background/{kind},
//     kind = default | tablet | mobile. REPLACE semantics on the card's
//     bg_{kind} FileField (public, like the favicon and the placeholders),
//     with bg_{kind}_url rewritten to the /api/files/... path.
//   - PUT /api/aerun/designs/{id}/placeholder/{kind} and the default-design
//     twin, kind = deleted | guest: the same REPLACE path the settings
//     placeholder endpoint uses, but onto the card.
//   - PUT /api/aerun/default-designs/{key}/favicon: the design favicon
//     upload, onto the default card.
//
// All of them require manage_designs and are deliberately NOT bound to
// enforceIdempotency (same reasoning as /me/avatar and the settings
// placeholder): the middleware buffers the body and caps it at 512 KB, which
// a multipart image can never satisfy. The writes are replaces on
// single-select FileFields, so a retried upload converges.
//
// Backgrounds need a 10 MB cap, not the 2 MB readImageUpload enforces, so
// they read through readImageUploadMax (see avatar_upload.go).

import (
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

const (
	// backgroundUploadMaxBytes is the per-file ceiling for card backgrounds:
	// 10 MB, the top of the plan's 5–10 MB range, uniform for client and
	// server. It matches the bg_* FileField MaxSize from 1781000010/0012.
	backgroundUploadMaxBytes int64 = 10 << 20
)

// designBackgroundKinds maps the URL path segment onto the file field and the
// reference column it drives. An unknown kind is refused rather than silently
// defaulted, so a typo in the client cannot overwrite the wrong image.
var designBackgroundKinds = map[string]struct {
	fileField string
	urlField  string
}{
	"default": {fileField: "bg_default", urlField: "bg_default_url"},
	"tablet":  {fileField: "bg_tablet", urlField: "bg_tablet_url"},
	"mobile":  {fileField: "bg_mobile", urlField: "bg_mobile_url"},
}

// cardPlaceholderKinds maps the URL path segment onto the card's placeholder
// file field and reference column.
var cardPlaceholderKinds = map[string]struct {
	fileField string
	urlField  string
}{
	"deleted": {fileField: "placeholder_deleted", urlField: "placeholder_deleted_url"},
	"guest":   {fileField: "placeholder_guest", urlField: "placeholder_guest_url"},
}

func requireManageDesigns(e *core.RequestEvent) error {
	acc := AccessFrom(e)
	if !auth.Has(acc.Permissions, auth.PermManageDesigns) {
		return router.NewForbiddenError("missing manage_designs permission", nil)
	}
	return nil
}

// storeCardBackground writes the uploaded bytes onto a card's bg_{kind} file
// field and returns the rewritten reference. Only PNG/JPEG/WebP/GIF are
// accepted — the formats the field's mime list allows and a browser renders
// as a background.
func storeCardBackground(e *core.RequestEvent, record *core.Record, fileField, urlField string) (string, error) {
	data, err := readImageUploadMax(e, "background", backgroundUploadMaxBytes)
	if err != nil {
		return "", err
	}

	name := "background" + avatarExtension(data)
	if name == "background.bin" {
		return "", validationError("background must be a PNG, JPEG, WebP or GIF image")
	}

	file, err := filesystem.NewFileFromBytes(data, name)
	if err != nil {
		return "", internalError("failed to read the uploaded background", err)
	}
	record.Set(fileField, file)
	record.Set("updated_at", time.Now())
	if err := e.App.Save(record); err != nil {
		return "", internalError("failed to store the background", err)
	}

	record.Set(urlField, AvatarFilePath(record.Collection().Id, record.Id, record.GetString(fileField)))
	if err := e.App.Save(record); err != nil {
		return "", internalError("failed to update the background reference", err)
	}

	return record.GetString(urlField), nil
}

// storeCardPlaceholder writes the uploaded bytes onto a card's placeholder
// file field and returns the rewritten reference, mirroring
// storeOwnedPlaceholder (same size/mime rules as the settings placeholder
// endpoint) with the card's updated_at touched.
func storeCardPlaceholder(e *core.RequestEvent, record *core.Record, fileField, urlField string) (string, error) {
	data, err := readAvatarUpload(e)
	if err != nil {
		return "", err
	}

	name := avatarFileName(data)
	if name == avatarFilePrefix+".bin" {
		return "", validationError("placeholder must be a PNG, JPEG, WebP or GIF image")
	}

	file, err := filesystem.NewFileFromBytes(data, name)
	if err != nil {
		return "", internalError("failed to read the uploaded placeholder", err)
	}
	record.Set(fileField, file)
	record.Set("updated_at", time.Now())
	if err := e.App.Save(record); err != nil {
		return "", internalError("failed to store the placeholder", err)
	}

	record.Set(urlField, AvatarFilePath(record.Collection().Id, record.Id, record.GetString(fileField)))
	if err := e.App.Save(record); err != nil {
		return "", internalError("failed to update the placeholder reference", err)
	}

	return record.GetString(urlField), nil
}

func findDesignByID(app core.App, id string) (*core.Record, error) {
	return app.FindRecordById(designsCollectionName, id)
}

// uploadDesignBackgroundHandler serves PUT /api/aerun/designs/{id}/background/{kind}.
func uploadDesignBackgroundHandler(e *core.RequestEvent) error {
	if err := requireManageDesigns(e); err != nil {
		return err
	}
	kind := strings.TrimSpace(e.Request.PathValue("kind"))
	fields, ok := designBackgroundKinds[kind]
	if !ok {
		return validationError("background kind must be \"default\", \"tablet\" or \"mobile\"")
	}
	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return validationError("design id is required")
	}
	rec, err := findDesignByID(e.App, id)
	if err != nil || rec == nil {
		return notFoundError("design not found")
	}

	url, err := storeCardBackground(e, rec, fields.fileField, fields.urlField)
	if err != nil {
		return err
	}

	_ = recordAuditLog(e.App, "design_background_uploaded", e.Auth.Id, map[string]any{
		"target_id": rec.Id,
		"kind":      kind,
	})

	return e.JSON(http.StatusOK, map[string]any{
		fields.urlField: url,
		"design":        designRecordPayload(rec),
		"request_id":    requestIDFrom(e),
	})
}

// uploadDefaultDesignBackgroundHandler serves PUT /api/aerun/default-designs/{key}/background/{kind}.
func uploadDefaultDesignBackgroundHandler(e *core.RequestEvent) error {
	if err := requireManageDesigns(e); err != nil {
		return err
	}
	kind := strings.TrimSpace(e.Request.PathValue("kind"))
	fields, ok := designBackgroundKinds[kind]
	if !ok {
		return validationError("background kind must be \"default\", \"tablet\" or \"mobile\"")
	}
	key := strings.TrimSpace(e.Request.PathValue("key"))
	if key == "" {
		return validationError("default design key is required")
	}
	rec, err := findDefaultDesignByKey(e.App, key)
	if err != nil || rec == nil {
		return notFoundError("default design not found")
	}

	url, err := storeCardBackground(e, rec, fields.fileField, fields.urlField)
	if err != nil {
		return err
	}

	_ = recordAuditLog(e.App, "default_design_background_uploaded", e.Auth.Id, map[string]any{
		"target_id": rec.Id,
		"key":       rec.GetString("key"),
		"kind":      kind,
	})

	return e.JSON(http.StatusOK, map[string]any{
		fields.urlField:  url,
		"default_design": defaultDesignRecordPayload(rec),
		"request_id":     requestIDFrom(e),
	})
}

// uploadDesignPlaceholderHandler serves PUT /api/aerun/designs/{id}/placeholder/{kind}.
func uploadDesignPlaceholderHandler(e *core.RequestEvent) error {
	if err := requireManageDesigns(e); err != nil {
		return err
	}
	kind := strings.TrimSpace(e.Request.PathValue("kind"))
	fields, ok := cardPlaceholderKinds[kind]
	if !ok {
		return validationError("placeholder kind must be \"deleted\" or \"guest\"")
	}
	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return validationError("design id is required")
	}
	rec, err := findDesignByID(e.App, id)
	if err != nil || rec == nil {
		return notFoundError("design not found")
	}

	url, err := storeCardPlaceholder(e, rec, fields.fileField, fields.urlField)
	if err != nil {
		return err
	}

	_ = recordAuditLog(e.App, "design_placeholder_uploaded", e.Auth.Id, map[string]any{
		"target_id": rec.Id,
		"kind":      kind,
	})

	return e.JSON(http.StatusOK, map[string]any{
		fields.urlField: url,
		"design":        designRecordPayload(rec),
		"request_id":    requestIDFrom(e),
	})
}

// uploadDefaultDesignPlaceholderHandler serves PUT /api/aerun/default-designs/{key}/placeholder/{kind}.
func uploadDefaultDesignPlaceholderHandler(e *core.RequestEvent) error {
	if err := requireManageDesigns(e); err != nil {
		return err
	}
	kind := strings.TrimSpace(e.Request.PathValue("kind"))
	fields, ok := cardPlaceholderKinds[kind]
	if !ok {
		return validationError("placeholder kind must be \"deleted\" or \"guest\"")
	}
	key := strings.TrimSpace(e.Request.PathValue("key"))
	if key == "" {
		return validationError("default design key is required")
	}
	rec, err := findDefaultDesignByKey(e.App, key)
	if err != nil || rec == nil {
		return notFoundError("default design not found")
	}

	url, err := storeCardPlaceholder(e, rec, fields.fileField, fields.urlField)
	if err != nil {
		return err
	}

	_ = recordAuditLog(e.App, "default_design_placeholder_uploaded", e.Auth.Id, map[string]any{
		"target_id": rec.Id,
		"key":       rec.GetString("key"),
		"kind":      kind,
	})

	return e.JSON(http.StatusOK, map[string]any{
		fields.urlField:  url,
		"default_design": defaultDesignRecordPayload(rec),
		"request_id":     requestIDFrom(e),
	})
}

// uploadDefaultDesignFaviconHandler serves PUT /api/aerun/default-designs/{key}/favicon,
// mirroring uploadDesignFaviconHandler onto the default card.
func uploadDefaultDesignFaviconHandler(e *core.RequestEvent) error {
	if err := requireManageDesigns(e); err != nil {
		return err
	}
	key := strings.TrimSpace(e.Request.PathValue("key"))
	if key == "" {
		return validationError("default design key is required")
	}
	rec, err := findDefaultDesignByKey(e.App, key)
	if err != nil || rec == nil {
		return notFoundError("default design not found")
	}

	url, err := storeOwnedFavicon(e, rec, true)
	if err != nil {
		return err
	}

	_ = recordAuditLog(e.App, "default_design_updated", e.Auth.Id, map[string]any{
		"target_id":       rec.Id,
		"key":             rec.GetString("key"),
		"name":            rec.GetString("name"),
		"favicon_updated": true,
	})

	return e.JSON(http.StatusOK, map[string]any{
		"favicon_url":    url,
		"default_design": defaultDesignRecordPayload(rec),
		"request_id":     requestIDFrom(e),
	})
}
