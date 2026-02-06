interface ConfirmOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isNested?: boolean;
}

export function ConfirmOverlay({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  isNested = false
}: ConfirmOverlayProps) {
  if (!isOpen) return null;

  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  return (
    <div className={`modal-overlay${isNested ? ' modal-overlay-nested' : ''}`} onClick={onClose}>
      <div className={`modal-content${isNested ? ' modal-content-nested' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div style={{ padding: '1.5rem' }}>
          <p style={{ marginBottom: '1.5rem', color: '#cccccc' }}>{message}</p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={onClose}>
              {cancelText}
            </button>
            <button className="btn btn-primary" onClick={handleConfirm}>
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
