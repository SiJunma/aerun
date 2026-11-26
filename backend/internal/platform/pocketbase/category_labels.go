package pocketbase

// Bilingual {en, ru} labels for category groups and categories.
//
// The cutover originally collapsed the legacy {en, ru} maps to a single string
// at every layer (TASK-2 §contract): the client kept Russian, the server stored
// one column, and the read path duplicated that string into both languages.
// The admin board has two independent inputs per label (Title EN / Title RU), so
// an EN edit was accepted, thrown away on the way in, and served back as the RU
// text in BOTH columns — the toast said "saved" while English reverted.
//
// A label now travels the whole way as {en, ru}:
//
//   - `title_i18n` / `name_i18n` / `description_i18n` (JSON, migration
//     1769200000) hold the two languages.
//   - the legacy `title` / `name` / `description` text columns keep holding the
//     primary rendering (Russian, English as fallback): slug derivation, the
//     importer's match checks, audit rows and every other single-string reader
//     are untouched by this file.
//   - a row written without i18n (the importer, a raw test fixture) reads back
//     with the legacy string in BOTH languages — exactly what the collapsed
//     contract served.

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// labelInput is one label field of a command body. The client may send a plain
// string (the collapsed contract, still accepted — a string is a label that
// means the same thing in both languages) or an {en, ru} object.
//
// Per-language presence matters on PATCH: an object that omits `ru` must not
// blank the stored Russian text, the same way an absent field leaves the column
// alone. An explicitly empty string ("") is a real instruction — clear it — so
// "key absent" and "key empty" are deliberately different answers.
type labelInput struct {
	set   bool // the field itself was present in the payload
	en    string
	ru    string
	enSet bool // the `en` key was present (even as "")
	ruSet bool
}

// UnmarshalJSON accepts `null`, a string, or an {en, ru} object of strings.
// Anything else is a malformed payload: the handler turns this error into a 400
// rather than guessing which half the client meant.
func (l *labelInput) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		return nil // absent — leave the stored label alone
	}

	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		s = strings.TrimSpace(s)
		l.set, l.en, l.ru = true, s, s
		l.enSet, l.ruSet = true, true
		return nil
	}

	if trimmed[0] == '{' {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(data, &fields); err != nil {
			return err
		}
		read := func(key string) (string, bool, error) {
			raw, ok := fields[key]
			if !ok || strings.TrimSpace(string(raw)) == "null" {
				return "", false, nil // key absent — keep the stored value
			}
			var s string
			if err := json.Unmarshal(raw, &s); err != nil {
				return "", false, fmt.Errorf("label %q must be a string", key)
			}
			return strings.TrimSpace(s), true, nil
		}
		en, enSet, err := read("en")
		if err != nil {
			return err
		}
		ru, ruSet, err := read("ru")
		if err != nil {
			return err
		}
		l.set, l.en, l.ru, l.enSet, l.ruSet = true, en, ru, enSet, ruSet
		return nil
	}

	return fmt.Errorf("label must be a string or an {en, ru} object")
}

// isEmpty reports whether the input carries no text at all in either language.
func (l labelInput) isEmpty() bool {
	return l.en == "" && l.ru == ""
}

// primary is the single-string rendering of the label: Russian wins because the
// board renders Russian by default, English is the fallback so an EN-only label
// is not lost — the same rule collapseLabelMap applies in the importer.
func (l labelInput) primary() string {
	if l.ru != "" {
		return l.ru
	}
	return l.en
}

// mergeLabel applies `in` to the stored pair. A key the payload omitted keeps
// its stored value; a key present (even empty) replaces it.
func mergeLabel(currentEn, currentRu string, in labelInput) (string, string) {
	en, ru := currentEn, currentRu
	if in.enSet {
		en = in.en
	}
	if in.ruSet {
		ru = in.ru
	}
	return en, ru
}

// labelPair reads the stored {en, ru} of one label, falling back to the legacy
// single column in BOTH languages when the i18n payload is empty (pre-migration
// rows, importer rows, raw test fixtures).
func labelPair(rec *core.Record, i18nField, legacyField string) (string, string) {
	en, ru := decodeLabelPair(rec.Get(i18nField))
	if en == "" && ru == "" {
		legacy := strings.TrimSpace(rec.GetString(legacyField))
		return legacy, legacy
	}
	return en, ru
}

// bilingual is the {en, ru} shape the label payloads use. Kept as a map
// rather than a struct because the client sends and receives it that way and
// the languages are not a closed set. (Forum branding no longer uses it: the
// forum name and header are plain single-variant strings since the surfaces
// rework.)
type bilingual map[string]any

// labelFromRecord builds the {en, ru} payload value for one label.
func labelFromRecord(rec *core.Record, i18nField, legacyField string) bilingual {
	en, ru := labelPair(rec, i18nField, legacyField)
	return bilingual{"en": en, "ru": ru}
}

// applyLabel writes both spellings of one label: the i18n pair and the legacy
// single column (primary), which slug derivation, the importer's match checks
// and the audit row keep reading.
func applyLabel(rec *core.Record, i18nField, legacyField, en, ru string) {
	primary := en
	if ru != "" {
		primary = ru
	}
	rec.Set(legacyField, primary)
	rec.Set(i18nField, map[string]any{"en": en, "ru": ru})
}

// decodeLabelPair unwraps a stored JSON label into its two languages.
//
// PocketBase surfaces a saved JSONField as types.JSONRaw rather than a map —
// the same trap the forum-name reader (readPlainString in global_settings.go)
// documents: without the raw cases a label written through the admin panel
// would read back empty. A plain string (nobody should write one, but a
// hand-edited dump might) is treated as both languages rather than dropped.
func decodeLabelPair(raw any) (string, string) {
	var payload []byte
	switch v := raw.(type) {
	case nil:
		return "", ""
	case map[string]any:
		return labelLeaf(v, "en"), labelLeaf(v, "ru")
	case types.JSONRaw:
		payload = v
	case []byte:
		payload = v
	case string:
		if strings.TrimSpace(v) == "" {
			return "", ""
		}
		payload = []byte(v)
	default:
		return "", ""
	}
	if len(payload) == 0 {
		return "", ""
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return "", ""
	}
	return labelLeaf(decoded, "en"), labelLeaf(decoded, "ru")
}

// labelLeaf pulls a string out of a decoded JSON object; a non-string leaf
// (nested object, number) reads as "" rather than poisoning the payload with
// "[object Object]" — the same rule the old bilingual forum-name normaliser
// applied before the name became a plain string.
func labelLeaf(decoded map[string]any, key string) string {
	value, _ := decoded[key].(string)
	return strings.TrimSpace(value)
}
