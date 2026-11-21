import React from 'react';
import { Tabs, Tab } from 'react-bootstrap';
import { SMILE_PACKS } from '../../config/smiles';

const SmilesPicker = ({ onSelect }) => {
  return (
    <div className="smiles-picker-container">
      <Tabs defaultActiveKey={SMILE_PACKS[0]?.id} id="smiles-tabs" className="smiles-tabs" mountOnEnter>
        {SMILE_PACKS.map(pack => (
          <Tab eventKey={pack.id} title={pack.name} key={pack.id} className="smiles-tab">
            <div className="smiles-grid">
              {pack.smiles.map(smile => (
                <button
                  key={smile.code}
                  type="button"
                  className="smile-item"
                  onClick={() => onSelect(smile.code)}
                  title={smile.code}
                >
                  <img
                    src={smile.url}
                    alt={smile.code}
                    loading="lazy"
                    className="smile-image"
                  />
                </button>
              ))}
            </div>
          </Tab>
        ))}
      </Tabs>
    </div>
  );
};

export default SmilesPicker;
