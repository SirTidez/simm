import React from 'react';

interface MessageOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  message: string;
  type?: 'success' | 'error' | 'info';
}

export function MessageOverlay({
  isOpen,
  onClose,
  title,
  message,
  type = 'info'
}: MessageOverlayProps) {
  if (!isOpen) return null;

  const getTypeStyles = () => {
    switch (type) {
      case 'success':
        return {
          borderColor: '#28a745',
          backgroundColor: '#1e5a2e'
        };
      case 'error':
        return {
          borderColor: '#dc3545',
          backgroundColor: '#5a1e1e'
        };
      case 'info':
      default:
        return {
          borderColor: '#17a2b8',
          backgroundColor: '#1e3a5f'
        };
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div style={{ padding: '1.5rem' }}>
          <div
            style={{
              padding: '1rem',
              borderRadius: '4px',
              border: `1px solid ${getTypeStyles().borderColor}`,
              backgroundColor: getTypeStyles().backgroundColor,
              color: '#ffffff',
              marginBottom: '1.5rem'
            }}
          >
            {message}
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={onClose}>
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
