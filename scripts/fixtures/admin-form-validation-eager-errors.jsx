// Fixture: validation firing BEFORE the admin has done anything — the exact
// complaint that produced a modal opening on two red inputs and a red sentence
// for a form nobody had touched yet.
//
// Here the button is locked on validity alone AND the fields go red on open.
// Both halves are the bug: an unclickable button can never reveal the errors it
// hides, so this shape collapses back into the original silent no-op.
//
// `node scripts/check-admin-form-validation.mjs <this file>` MUST fail.
const groupForm = { title: { en: '', ru: '' } };
const catForm = { title: { en: '', ru: '' }, group_id: '' };
const roleForm = { name: '' };

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
const groupTitleFilled = Boolean(trimmed(groupForm.title?.en) || trimmed(groupForm.title?.ru));
const catTitleFilled = Boolean(trimmed(catForm.title?.en) || trimmed(catForm.title?.ru));
const catGroupChosen = Boolean(catForm.group_id);
const roleNameFilled = Boolean(trimmed(roleForm.name));

// No "Attempted" flag anywhere: these fire on open.
const groupFormValid = groupTitleFilled;
const catFormValid = catTitleFilled && catGroupChosen;
const showGroupError = !groupFormValid;
const showRoleNameError = !roleNameFilled;

const handleSaveGroup = async () => {
  if (!trimmed(groupForm.title?.en) && !trimmed(groupForm.title?.ru)) return;
  await saveGroup();
};

const handleSaveCategory = async () => {
  if (!trimmed(catForm.title?.en) && !trimmed(catForm.title?.ru)) return;
  await saveCategory();
};

const handleSaveRole = async () => {
  if (!trimmed(roleForm.name)) return;
  await saveRole();
};

const Modals = () => (
  <>
    <Form.Control type="text" value={groupForm.title?.en || ''} isInvalid={showGroupError} />
    <Form.Control type="text" value={groupForm.title?.ru || ''} isInvalid={showGroupError} />
    {/* The bug: d-block is display:block !important, which outranks
        .invalid-feedback{display:none}, so this hint is on screen from the
        moment the modal opens. */}
    <Form.Control.Feedback type="invalid" className="d-block">
      Fill in at least one title.
    </Form.Control.Feedback>
    <Button variant="primary" onClick={handleSaveGroup} disabled={saving || !groupFormValid}>Save</Button>

    <Form.Control type="text" value={catForm.title?.en || ''} isInvalid={!catTitleFilled} />
    <Form.Control type="text" value={catForm.title?.ru || ''} isInvalid={!catTitleFilled} />
    <Form.Select value={catForm.group_id} isInvalid={!catGroupChosen} />
    <Button variant="primary" onClick={handleSaveCategory} disabled={saving || !catFormValid}>Save</Button>

    <Form.Control type="text" value={roleForm.name} isInvalid={showRoleNameError} />
    <Button variant="primary" onClick={handleSaveRole} disabled={saving || !roleNameFilled}>Save</Button>
  </>
);