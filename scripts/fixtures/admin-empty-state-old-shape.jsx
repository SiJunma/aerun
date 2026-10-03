// Fixture: the OLD, buggy shape of renderCategories() — the shape that produced
// the screenshot (bare dark table header + a phantom "General" category).
// `npm run test:admin-empty-state -- <this file>` MUST fail on it, otherwise
// the check is not actually detecting the regression it was written for.
const renderCategories = () => (
  <>
    <Card>
      <Table hover responsive>
        <thead>
          <tr><th>{t('admin.categories.group_order')}</th></tr>
        </thead>
        <tbody>
          {groups.map(group => (
            <tr key={group.id}><td>{group.order}</td></tr>
          ))}
        </tbody>
      </Table>
    </Card>
    <Card>
      <Table hover responsive>
        <thead>
          <tr><th>{t('admin.categories.table_order')}</th></tr>
        </thead>
        <tbody>
          {(() => {
            const unassignedCats = categories.filter(c => !groups.find(g => g.id === c.group_id));
            if (unassignedCats.length === 0 && groups.length > 0) return null;
            return (
              <React.Fragment>
                <tr className="table-active">
                  <td colSpan="3">{t('admin.categories.group_unassigned')}</td>
                </tr>
                {unassignedCats.length === 0 ? (
                  <tr>
                    <td colSpan="4">No unassigned forums</td>
                  </tr>
                ) : unassignedCats.map(cat => (
                  <tr key={cat.id}><td>{cat.order}</td></tr>
                ))}
              </React.Fragment>
            );
          })()}
        </tbody>
      </Table>
    </Card>
  </>
);