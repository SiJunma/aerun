import React from 'react';
import { useI18n } from '../contexts/I18nProvider';

const MembersPage = () => {
  const { t } = useI18n();
  return (
    <div className="py-5">
      <h1>{t('nav.members')}</h1>
      <p className="lead">Members directory is under construction.</p>
    </div>
  );
};

export default MembersPage;
