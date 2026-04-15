import React from 'react';
import { Tabs, Tab, Row, Col } from 'react-bootstrap';
import { SMILE_PACKS } from '../../config/smiles';

const SmilesPicker = ({ onSelect }) => {
  return (
    <div className="smiles-picker-container p-2" style={{ 
      maxHeight: '350px', 
      overflowY: 'auto', 
      width: '100%',
      backgroundColor: 'var(--card-bg)',
      color: 'var(--text-color)',
      borderRadius: '8px',
      overscrollBehavior: 'contain'
    }}>
      <Tabs defaultActiveKey={SMILE_PACKS[0]?.id} id="smiles-tabs" className="mb-2 smiles-tabs-custom">
        {SMILE_PACKS.map(pack => (
          <Tab eventKey={pack.id} title={pack.name} key={pack.id}>
            <div className="d-flex flex-wrap gap-2 mt-2">
              {pack.smiles.map(smile => (
                <div
                  key={smile.code}
                  className="smile-item rounded p-1 cursor-pointer hover-bg-theme"
                  onClick={() => onSelect(smile.code)}
                  title={smile.code}
                  style={{ 
                    cursor: 'pointer',
                    transition: 'transform 0.1s ease',
                  }}
                >
                  <img
                    src={smile.url}
                    alt={smile.code}
                    className="smile-image"
                    style={{ width: '40px', height: '40px', objectFit: 'contain' }}
                    onMouseOver={(e) => e.currentTarget.parentElement.style.transform = 'scale(1.2)'}
                    onMouseOut={(e) => e.currentTarget.parentElement.style.transform = 'scale(1.0)'}
                  />
                </div>
              ))}
            </div>
          </Tab>
        ))}
      </Tabs>

      <style>{`
        .smiles-tabs-custom .nav-link {
          padding: 0.4rem 0.8rem;
          font-size: 0.85rem;
          color: var(--secondary-color);
          border: none;
        }
        .smiles-tabs-custom .nav-link.active {
          background: transparent !important;
          color: var(--primary-color) !important;
          border-bottom: 2px solid var(--primary-color) !important;
          font-weight: 600;
        }
        .hover-bg-theme:hover {
          background-color: rgba(var(--primary-rgb, 13, 110, 253), 0.15);
          border-radius: 8px;
        }
        .smiles-picker-container::-webkit-scrollbar {
          width: 6px;
        }
        .smiles-picker-container::-webkit-scrollbar-track {
          background: transparent;
        }
        .smiles-picker-container::-webkit-scrollbar-thumb {
          background: var(--border-color);
          border-radius: 10px;
        }
      `}</style>
    </div>
  );
};

export default SmilesPicker;
