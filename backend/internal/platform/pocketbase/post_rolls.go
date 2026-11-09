package pocketbase

// Dice rolls on posts and DM messages (schema: migration 1768200000).
//
// The browser generates a throw and sends BOTH halves of it: the body carries
// `[roll=<id>]` and the request carries the companion map. This file is where
// those two halves are joined up — and, for master rolls, where they are
// deliberately separated again on the way out.
//
// Everything here is a THIN adapter over internal/forum: the rules live there
// so they can be tested without a database, and this package only deals with
// the PocketBase-specific parts — decoding a JSON column, and deciding what
// each reader is allowed to see.

import (
	"encoding/json"
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
	"github.com/SiJunma/aerun/backend/internal/forum"
)

// decodeRolls reads a `rolls` JSON column into a map.
//
// PocketBase stores JSON fields as types.JSONRaw, but the same value reaches
// this package as a plain map (what record.Set writes in tests and in the
// importer) or as a JSON string (what an older row may hold), so all three
// shapes are accepted — the same tolerance decodeRoleIDList applies to
// `categories.allowed_roles`. A missing value decodes to an empty map, which
// every caller reads as "this post has no throws".
func decodeRolls(raw any) (map[string]any, error) {
	out := map[string]any{}

	var payload []byte
	switch value := raw.(type) {
	case nil:
		return out, nil
	case map[string]any:
		return value, nil
	case types.JSONRaw:
		payload = value
	case []byte:
		payload = value
	case string:
		payload = []byte(value)
	default:
		return nil, fmt.Errorf("unexpected rolls value type %T", value)
	}

	if len(payload) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(payload, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

// writeRolls validates a client-supplied roll map against the body and stores
// the result on the record.
//
// An absent or empty map is stored as an empty object rather than left unset,
// so "this post has no throws" is a value the column actually holds instead of
// something every reader has to special-case.
//
// The error is returned unwrapped on purpose: it is a validation failure the
// caller turns into a 422, and the message names the offending roll.
func writeRolls(record *core.Record, content string, incoming map[string]any) error {
	clean, err := forum.ValidateRolls(content, incoming)
	if err != nil {
		return err
	}
	if clean == nil {
		clean = map[string]any{}
	}
	record.Set("rolls", clean)
	return nil
}

// writeRollsFrozen is writeRolls with the freeze applied (SEC-08 edit).
//
// stored is the map the record already holds (decodeRolls of the current
// column). An incoming entry whose id already exists in stored AND whose
// entry differs is a forgery attempt and is refused as ErrRollConflict — a
// different error kind from a malformed entry, so the API layer can surface
// the freeze rather than a validation failure.
//
// A master roll stored with a nil value is byte-identical to itself: the
// incoming value that redacts to nil (author does not hold
// view_master_dice) is not treated as an overwrite, because rollEntryEqual
// compares the sanitized form and a nil stays nil.
func writeRollsFrozen(record *core.Record, content string, incoming, stored map[string]any) error {
	if err := forum.ValidateRollsFreeze(stored, incoming); err != nil {
		return err
	}
	return writeRolls(record, content, incoming)
}

// storedRolls reads the rolls column from a record and returns it as a map
// (empty when absent). Used by the edit path to hand the freeze checker
// what is already frozen on the row.
func storedRolls(record *core.Record) map[string]any {
	if record == nil {
		return map[string]any{}
	}
	rolls, err := decodeRolls(record.Get("rolls"))
	if err != nil || rolls == nil {
		return map[string]any{}
	}
	return rolls
}

// rollsFor renders the stored map for one reader.
//
// This is the security boundary. `view_master_dice` decides whether a master
// throw's value is included at all; a reader without it receives the roll with
// a null value, which BBCode already renders as "Master Roll (hidden)". The
// alternative — sending the value and trusting the renderer to keep quiet —
// publishes the secret to anybody who opens the network tab, which is the
// defect this indirection exists to prevent.
//
// It is a separate pass rather than part of postPayload because the payload is
// built from the record alone, while redaction is a property of the READER.
// That mirrors how `author_character_id` travels raw and is resolved by
// decoratePostAuthor.
//
// The author's OWN reply comes back through the same path, so an author
// without `view_master_dice` also sees their master roll as hidden. That is
// the correct reading of the permission: master dice are for the people who
// run the game, whoever happens to have typed the tag.
func rollsFor(stored map[string]any, acc AccessContext) map[string]any {
	return forum.RedactRolls(stored, auth.Has(acc.Permissions, auth.PermViewMasterDice))
}

// redactPostRolls applies rollsFor across a page of payloads, in place.
//
// In place is correct here and only here: these payload maps are built fresh
// per request by postPayload and are handed to exactly one response, so there
// is no shared state to protect — the record's own map was already copied by
// decodeRolls.
func redactPostRolls(payloads []map[string]any, acc AccessContext) {
	for _, payload := range payloads {
		stored, ok := payload["rolls"].(map[string]any)
		if !ok || len(stored) == 0 {
			continue
		}
		if redacted := rollsFor(stored, acc); len(redacted) > 0 {
			payload["rolls"] = redacted
		} else {
			delete(payload, "rolls")
		}
	}
}
