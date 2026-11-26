package pocketbase

// Avatar upload (PUT /api/aerun/me/avatar).
//
// The browser cannot do this itself: the `users` collection has a nil UpdateRule
// (deny-by-default, plan invariant 2), so `pb.collection('users').update(...)`
// is refused by PocketBase before it reaches any field. The only writer of
// `users.avatar` is this command, exactly as the legacy Storage write was.
//
// Why this replaces the data-URL path: `avatar_url` is a TextField capped at
// 512 characters, and an inline `data:image/...;base64,...` avatar is tens of
// kilobytes. The old client-side uploader produced one and handed it straight to
// the profile save, so the write could only ever fail — silently, in the UI,
// with "saved" showing. Bytes belong in the FileField added by 1767000000, and
// `avatar_url` becomes a short host-agnostic reference to them, which is the
// same invariant the legacy importer established.
//
// Deliberately NOT bound to `enforceIdempotency`, which is a documented
// deviation from plan invariant 6: that middleware buffers the whole request
// body into the idempotency envelope and caps it at 512 KB, so a multipart
// avatar can never pass it — binding it would turn every upload into a 413.
// The command is safe without the envelope because it is a replace, not an
// accumulate: PocketBase deletes the previous file when a single-select
// FileField is overwritten, so a retried or double-submitted upload converges
// on one stored file instead of stacking duplicates.

import (
	"errors"
	"io"
	"net/http"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

const (
	// avatarFormField is the multipart part name the client sends.
	avatarFormField = "file"
	// avatarUploadMaxBytes is the per-file ceiling. It matches the client's own
	// 2 MB cap (AvatarUploader) and sits well under the 5 MB FileField limit, so
	// an oversized request is refused before it is buffered rather than after.
	avatarUploadMaxBytes int64 = 2 << 20
	// avatarUploadMaxBodyBytes is the ceiling for the whole request body. The
	// multipart envelope (boundary lines, part headers, the trailing boundary)
	// adds a few hundred bytes over the file itself, so the body cap carries
	// headroom and the exact file limit is enforced on the parsed part.
	avatarUploadMaxBodyBytes = avatarUploadMaxBytes + 16*1024
)

// uploadMyAvatarHandler stores a new avatar for the caller's own account and
// rewrites avatar_url to point at it.
//
// It follows the settings command's access rule: any authenticated forum
// account may change its own avatar, except a banned one. Pending accounts keep
// the legacy self-service right; note that their avatar is stored but not
// publicly served (the ViewRule only publishes active accounts), which is the
// same trade-off the profile itself has.
func uploadMyAvatarHandler(e *core.RequestEvent) error {
	record := e.Auth
	if record == nil {
		return router.NewUnauthorizedError("authentication is required for this action", nil)
	}
	if record.Collection().Name != usersCollectionName {
		return router.NewForbiddenError("this endpoint serves forum accounts only", nil)
	}
	if acc := AccessFrom(e); acc.Status == auth.StatusBanned {
		return router.NewForbiddenError("banned accounts cannot change their avatar", nil)
	}

	avatarURL, err := storeOwnedAvatar(e, record, avatarFieldName)
	if err != nil {
		return err
	}

	return e.JSON(http.StatusOK, map[string]any{
		"avatar_url": avatarURL,
		"request_id": requestIDFrom(e),
	})
}

// storeOwnedAvatar writes the uploaded file onto a record's avatar field and
// returns the rewritten avatar_url.
//
// Two saves are unavoidable and are the same two-step the importer performs:
// PocketBase assigns the stored file name (a random id plus the base name)
// during the save, so avatar_url can only be built once the name is known.
func storeOwnedAvatar(e *core.RequestEvent, record *core.Record, field string) (string, error) {
	data, err := readAvatarUpload(e)
	if err != nil {
		return "", err
	}

	name := avatarFileName(data)
	if name == avatarFilePrefix+".bin" {
		// The sniffer did not recognise the bytes, so the upload is not one of
		// the formats the field accepts. Saying so beats storing a file the
		// browser will render as a broken image.
		return "", validationError("avatar must be a PNG, JPEG, WebP or GIF image")
	}

	file, err := filesystem.NewFileFromBytes(data, name)
	if err != nil {
		return "", internalError("failed to read the uploaded avatar", err)
	}
	record.Set(field, file)
	if err := e.App.Save(record); err != nil {
		return "", internalError("failed to store the avatar", err)
	}

	record.Set(avatarURLFieldName, AvatarFilePath(record.Collection().Id, record.Id, record.GetString(field)))
	if err := e.App.Save(record); err != nil {
		return "", internalError("failed to update the avatar reference", err)
	}

	return record.GetString(avatarURLFieldName), nil
}

// readAvatarUpload extracts and bounds the uploaded bytes.
//
// The body is capped with http.MaxBytesReader BEFORE parsing so an oversized
// upload is refused while streaming rather than after being spooled to a temp
// file. The multipart envelope (boundaries, part headers) costs a few hundred
// bytes on top of the file itself, so the body ceiling sits slightly above the
// file ceiling and the real limit is applied to the part once it is parsed.
//
// That ordering matters for the error a user sees: MaxBytesReader trips inside
// ParseMultipartForm, so without the explicit Content-Length pre-check an
// oversized upload would be reported as "must be sent as multipart/form-data" —
// telling someone who did send multipart that their content type is wrong.
//
// The format is decided by the bytes, never by the client's Content-Type or
// filename: those are attacker-controlled, and the stored name is derived from
// the sniffed extension (avatarFileName) precisely so PocketBase serves the
// right Content-Type back.
func readAvatarUpload(e *core.RequestEvent) ([]byte, error) {
	return readImageUpload(e, "avatar")
}

// readImageUpload extracts and bounds a multipart "file" upload labeled by
// `kindLabel` (e.g. "avatar" or "favicon").
func readImageUpload(e *core.RequestEvent, kindLabel string) ([]byte, error) {
	if e.Request.ContentLength > avatarUploadMaxBodyBytes {
		return nil, validationError(kindLabel + " exceeds the maximum allowed size")
	}

	e.Request.Body = http.MaxBytesReader(e.Response, e.Request.Body, avatarUploadMaxBodyBytes)
	if err := e.Request.ParseMultipartForm(avatarUploadMaxBodyBytes); err != nil {
		// Distinguish "too big" from "not multipart": a body that hit the
		// reader cap is a size problem, and saying otherwise sends the user
		// hunting a content-type bug they do not have.
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, validationError(kindLabel + " exceeds the maximum allowed size")
		}
		return nil, validationError(kindLabel + " must be sent as multipart/form-data")
	}

	// FormFile returns the already-opened part, so there is nothing to Open.
	src, header, err := e.Request.FormFile(avatarFormField)
	if err != nil {
		return nil, validationError("the multipart body has no '" + avatarFormField + "' part")
	}
	defer src.Close()

	if header.Size > avatarUploadMaxBytes {
		return nil, validationError(kindLabel + " exceeds the maximum allowed size")
	}

	// One byte over the limit is read so a body that only reveals its true
	// size at the end is caught here rather than silently truncated.
	data, err := io.ReadAll(io.LimitReader(src, avatarUploadMaxBytes+1))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, validationError(kindLabel + " exceeds the maximum allowed size")
		}
		return nil, validationError("the uploaded " + kindLabel + " could not be read")
	}
	if int64(len(data)) > avatarUploadMaxBytes {
		return nil, validationError(kindLabel + " exceeds the maximum allowed size")
	}
	if len(data) == 0 {
		return nil, validationError("the uploaded " + kindLabel + " is empty")
	}
	return data, nil
}
