package migrations

import (
	"encoding/json"
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

// 1781000010_designs_surfaces.go gives custom design cards the fields the
// Designs-tab surfaces rework needs (PLAN_DESIGNS_TAB_SURFACES.md §7.2):
//
//   - per-card backgrounds: bg_default / bg_tablet / bg_mobile FileFields
//     (10 MB, image only, public) + bg_*_url references + one bg_opacity;
//   - header_html (renamed from welcome_message, value copied as-is) and
//     custom_footer_html (JSON HTML strings, same storage as the old banner);
//   - one overwrite_* toggle per value that can fall back to surface 1
//     (header, footer, title, favicon, css, js, placeholder deleted/guest);
//   - per-card identity placeholders (placeholder_deleted / placeholder_guest
//     FileFields + _url references, same shape as the settings placeholders).
//
// There is no overwrite toggle for the background: it lives only on the card
// (§3.4). Old migrations are untouched; the rename copies the stored value
// before the old field is removed.
func init() {
	m.Register(applyDesignsSurfaces, revertDesignsSurfaces)
}

// designBackgroundFileMaxSize is the per-file cap for card backgrounds: 10 MB,
// the top of the 5–10 MB range the plan resolves in §9 question 4, uniform for
// client and server.
const designBackgroundFileMaxSize int64 = 10 << 20

var designBackgroundMimeTypes = []string{
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
}

// designSurfaceFields is every field this migration adds to `designs`, so the
// revert cannot drift from the apply.
func designSurfaceFields() []core.Field {
	fields := []core.Field{
		&core.FileField{
			Name:      "bg_default",
			MaxSelect: 1,
			MaxSize:   designBackgroundFileMaxSize,
			MimeTypes: designBackgroundMimeTypes,
		},
		&core.FileField{
			Name:      "bg_tablet",
			MaxSelect: 1,
			MaxSize:   designBackgroundFileMaxSize,
			MimeTypes: designBackgroundMimeTypes,
		},
		&core.FileField{
			Name:      "bg_mobile",
			MaxSelect: 1,
			MaxSize:   designBackgroundFileMaxSize,
			MimeTypes: designBackgroundMimeTypes,
		},
		&core.TextField{Name: "bg_default_url", Max: 512},
		&core.TextField{Name: "bg_tablet_url", Max: 512},
		&core.TextField{Name: "bg_mobile_url", Max: 512},
		&core.NumberField{Name: "bg_opacity", Min: float64Ptr(0), Max: float64Ptr(1)},
		&core.JSONField{Name: "header_html", MaxSize: 262144},
		&core.JSONField{Name: "custom_footer_html", MaxSize: 262144},
		&core.FileField{
			Name:      "placeholder_deleted",
			MaxSelect: 1,
			MaxSize:   identityPlaceholderFileMaxSize,
			MimeTypes: identityPlaceholderMimeTypes,
		},
		&core.FileField{
			Name:      "placeholder_guest",
			MaxSelect: 1,
			MaxSize:   identityPlaceholderFileMaxSize,
			MimeTypes: identityPlaceholderMimeTypes,
		},
		&core.TextField{Name: "placeholder_deleted_url", Max: 512},
		&core.TextField{Name: "placeholder_guest_url", Max: 512},
	}
	for _, name := range []string{
		"overwrite_header",
		"overwrite_footer",
		"overwrite_title",
		"overwrite_favicon",
		"overwrite_css",
		"overwrite_js",
		"overwrite_placeholder_deleted",
		"overwrite_placeholder_guest",
	} {
		fields = append(fields, &core.BoolField{Name: name})
	}
	return fields
}

func applyDesignsSurfaces(app core.App) error {
	col, err := app.FindCollectionByNameOrId("designs")
	if err != nil {
		return fmt.Errorf("designs: %w", err)
	}

	for _, field := range designSurfaceFields() {
		ensureField(col, field)
	}
	if err := app.Save(col); err != nil {
		return fmt.Errorf("designs surface fields: %w", err)
	}

	// Rename welcome_message -> header_html, copying the stored value as-is.
	// The copy runs BEFORE the old field is removed: removing the field drops
	// its column, so a copy after the removal would read nothing.
	if col.Fields.GetByName("welcome_message") != nil {
		records, err := app.FindAllRecords("designs")
		if err != nil {
			return fmt.Errorf("designs welcome_message copy: %w", err)
		}
		for _, rec := range records {
			// An unset JSONField can still read back non-nil (empty raw
			// bytes), so the "already converted" check decodes instead of
			// comparing against nil: only a real stored value skips the copy.
			if existing := decodeJSONFieldValue(rec.Get("header_html")); existing != nil && existing != "" {
				continue
			}
			if v := decodeJSONFieldValue(rec.Get("welcome_message")); v != nil {
				rec.Set("header_html", v)
				if err := app.Save(rec); err != nil {
					return fmt.Errorf("designs welcome_message copy: %w", err)
				}
			}
		}
		if existing := col.Fields.GetByName("welcome_message"); existing != nil {
			col.Fields.RemoveById(existing.GetId())
			if err := app.Save(col); err != nil {
				return fmt.Errorf("designs remove welcome_message: %w", err)
			}
		}
	}
	return nil
}

func revertDesignsSurfaces(app core.App) error {
	col, err := app.FindCollectionByNameOrId("designs")
	if err != nil || col == nil {
		return nil
	}

	// Re-add the old field FIRST: a record cannot hold a value for a field
	// its collection does not have, so the copy must run after the field
	// exists and before the new fields are removed.
	if col.Fields.GetByName("welcome_message") == nil {
		col.Fields.Add(&core.JSONField{Name: "welcome_message", MaxSize: 262144})
		if err := app.Save(col); err != nil {
			return err
		}
	}
	if col.Fields.GetByName("header_html") != nil {
		records, err := app.FindAllRecords("designs")
		if err == nil {
			for _, rec := range records {
				if v := decodeJSONFieldValue(rec.Get("header_html")); v != nil {
					rec.Set("welcome_message", v)
					_ = app.Save(rec)
				}
			}
		}
	}
	for _, field := range designSurfaceFields() {
		col.Fields.RemoveByName(field.GetName())
	}
	return app.Save(col)
}

// decodeJSONFieldValue unwraps a stored JSONField value into a plain Go value.
//
// PocketBase surfaces a saved JSONField as types.JSONRaw, not as the value
// that was written, so copying a field by assigning Get() directly would
// store the raw bytes as a nested JSON string. Decoding first keeps a stored
// HTML string a string on the other side of the rename.
func decodeJSONFieldValue(raw any) any {
	switch v := raw.(type) {
	case nil:
		return nil
	case types.JSONRaw:
		return decodeJSONBytes([]byte(v))
	case []byte:
		return decodeJSONBytes(v)
	case string:
		if trimmed := v; len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '"' || trimmed[0] == '[') {
			return decodeJSONBytes([]byte(trimmed))
		}
		return v
	default:
		return v
	}
}

func decodeJSONBytes(payload []byte) any {
	if len(payload) == 0 {
		return nil
	}
	var decoded any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return nil
	}
	return decoded
}

// bilingualLeaf picks the single-language value out of a stored {en, ru}
// bilingual map: ru first (plan §9 question 10), then en, then "".
func bilingualLeaf(raw any) string {
	decoded, ok := decodeJSONFieldValue(raw).(map[string]any)
	if !ok {
		if s, ok := decodeJSONFieldValue(raw).(string); ok {
			return s
		}
		return ""
	}
	for _, key := range []string{"ru", "en"} {
		if s, ok := decoded[key].(string); ok && s != "" {
			return s
		}
	}
	return ""
}
