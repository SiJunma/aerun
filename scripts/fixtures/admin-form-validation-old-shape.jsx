// Fixture: the OLD admin modals — Save buttons wired and enabled while their
// handlers returned early on an empty form.
//
//     const handleSaveGroup = async () => {
//       if (!groupForm.title?.en && !groupForm.title?.ru) return;   // silent
//     ...
//     <Button variant="primary" onClick={handleSaveGroup} disabled={saving}>
//
// Clicking Save did nothing at all. `node scripts/check-admin-form-validation.mjs
// scripts/fixtures/admin-form-validation-old-shape.jsx` MUST fail on it, otherwise
// the check is not detecting the regression it was written for.
const handleSaveGroup = async () => {
  if (!groupForm.title?.en && !groupForm.title?.ru) return;
  await saveGroup();
};

const handleSaveCategory = async () => {
  if (!catForm.title?.en && !catForm.title?.ru) return;
  await saveCategory();
};

const handleSaveRole = async () => {
  if (!roleForm.name) return;
  await saveRole();
};

const Modals = () => (
  <>
    <Form.Control type="text" value={groupForm.title?.en || ''} />
    <Form.Control type="text" value={groupForm.title?.ru || ''} />
    <Button variant="primary" onClick={handleSaveGroup} disabled={saving}>Save</Button>

    <Form.Control type="text" value={catForm.title?.en || ''} />
    <Form.Control type="text" value={catForm.title?.ru || ''} />
    <Form.Select value={catForm.group_id} />
    <Button variant="primary" onClick={handleSaveCategory} disabled={saving}>Save</Button>

    <Form.Control type="text" value={roleForm.name} />
    <Button variant="primary" onClick={handleSaveRole} disabled={saving}>Save</Button>
  </>
);