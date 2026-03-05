import React, { useState, useEffect, useRef } from 'react';
import { ColorPicker } from './ColorPicker';
import { GradientEditor } from './GradientEditor';
import { useSettingsStore } from '../stores/settingsStore';
import type { CustomTheme } from '../types';

// Global flag to prevent settingsStore from applying theme while editor is open
(window as any).__customThemeEditorOpen = false;

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const DEFAULT_CUSTOM_THEME: CustomTheme = {
  appBgColor: '#0f0f0f',
  appTextColor: 'rgba(255, 255, 255, 0.87)',
  headerBgColor: 'rgba(42, 42, 42, 0.7)',
  borderColor: 'rgba(58, 58, 58, 0.6)',
  cardBgColor: 'rgba(42, 42, 42, 0.6)',
  cardBorderColor: 'rgba(58, 58, 58, 0.5)',
  textSecondary: '#cccccc',
  inputBgColor: 'rgba(26, 26, 26, 0.7)',
  inputBorderColor: 'rgba(58, 58, 58, 0.6)',
  inputTextColor: '#ffffff',
  btnSecondaryBg: 'rgba(58, 58, 58, 0.6)',
  btnSecondaryHover: 'rgba(74, 74, 74, 0.8)',
  btnSecondaryText: '#ffffff',
  btnSecondaryBorder: 'rgba(74, 74, 74, 0.5)',
  infoBoxBg: 'rgba(30, 58, 95, 0.6)',
  infoBoxBorder: 'rgba(42, 74, 111, 0.6)',
  warningBoxBg: 'rgba(90, 58, 30, 0.6)',
  warningBoxBorder: 'rgba(106, 74, 47, 0.6)',
  infoPanelBg: 'rgba(26, 26, 26, 0.6)',
  infoPanelBorder: 'rgba(58, 58, 58, 0.4)',
  modalOverlay: 'rgba(0, 0, 0, 0.7)',
  bgGradient: 'linear-gradient(135deg, #0f0f0f 0%, #1a1a2e 25%, #16213e 50%, #0f3460 75%, #1a1a1a 100%)',
  bgPattern: 'radial-gradient(circle at 20% 30%, rgba(79, 70, 229, 0.08) 0%, transparent 50%), radial-gradient(circle at 80% 70%, rgba(139, 92, 246, 0.08) 0%, transparent 50%)',
  badgeGray: '#4a4a4a',
  badgeBlue: '#0066cc',
  badgeOrangeRed: '#cc5500',
  badgeYellow: '#ffaa00',
  badgeGreen: '#28a745',
  badgeRed: '#dc3545',
  badgeOrange: '#ff9800',
  badgeCyan: '#00bcd4',
  updateVersionColor: '#ff9800',
  updateVersionBg: 'rgba(255, 152, 0, 0.1)',
  primaryBtnColor: '#646cff',
  primaryBtnHover: '#535bf2',
};

const COLOR_GROUPS = [
  {
    name: 'Backgrounds',
    colors: [
      { key: 'bgGradient', label: 'Background Gradient/Pattern' },
      { key: 'appBgColor', label: 'App Background (Solid)' },
      { key: 'modalOverlay', label: 'Modal Overlay' },
    ],
  },
  {
    name: 'Base Colors',
    colors: [
      { key: 'appTextColor', label: 'App Text' },
      { key: 'textSecondary', label: 'Secondary Text' },
    ],
  },
  {
    name: 'Header & Cards',
    colors: [
      { key: 'headerBgColor', label: 'Header Background' },
      { key: 'cardBgColor', label: 'Card Background' },
      { key: 'cardBorderColor', label: 'Card Border' },
      { key: 'borderColor', label: 'Border' },
    ],
  },
  {
    name: 'Inputs',
    colors: [
      { key: 'inputBgColor', label: 'Input Background' },
      { key: 'inputBorderColor', label: 'Input Border' },
      { key: 'inputTextColor', label: 'Input Text' },
    ],
  },
  {
    name: 'Buttons',
    colors: [
      { key: 'btnSecondaryBg', label: 'Button Background' },
      { key: 'btnSecondaryHover', label: 'Button Hover' },
      { key: 'btnSecondaryText', label: 'Button Text' },
      { key: 'btnSecondaryBorder', label: 'Button Border' },
      { key: 'primaryBtnColor', label: 'Primary Button' },
      { key: 'primaryBtnHover', label: 'Primary Button Hover' },
    ],
  },
  {
    name: 'Info & Warnings',
    colors: [
      { key: 'infoBoxBg', label: 'Info Box Background' },
      { key: 'infoBoxBorder', label: 'Info Box Border' },
      { key: 'warningBoxBg', label: 'Warning Box Background' },
      { key: 'warningBoxBorder', label: 'Warning Box Border' },
      { key: 'infoPanelBg', label: 'Info Panel Background' },
      { key: 'infoPanelBorder', label: 'Info Panel Border' },
    ],
  },
  {
    name: 'Badges',
    colors: [
      { key: 'badgeGray', label: 'Gray Badge' },
      { key: 'badgeBlue', label: 'Blue Badge' },
      { key: 'badgeOrangeRed', label: 'Orange-Red Badge' },
      { key: 'badgeYellow', label: 'Yellow Badge' },
      { key: 'badgeGreen', label: 'Green Badge' },
      { key: 'badgeRed', label: 'Red Badge' },
      { key: 'badgeOrange', label: 'Orange Badge' },
      { key: 'badgeCyan', label: 'Cyan Badge' },
    ],
  },
  {
    name: 'Updates',
    colors: [
      { key: 'updateVersionColor', label: 'Update Version Color' },
      { key: 'updateVersionBg', label: 'Update Version Background' },
    ],
  },
];

export function CustomThemeEditor({ isOpen, onClose }: Props) {
  const { settings, updateSettings, refreshSettings } = useSettingsStore();
  const [theme, setTheme] = useState<CustomTheme>(DEFAULT_CUSTOM_THEME);
  const [editingColor, setEditingColor] = useState<string | null>(null);
  const [editingGradient, setEditingGradient] = useState<string | null>(null);
  const [gradientEditMode, setGradientEditMode] = useState<'gradient' | 'pattern'>('gradient');
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [appBgMode, setAppBgMode] = useState<'solid' | 'gradient'>('gradient');
  const colorPickerClosingRef = useRef(false);
  const colorPickerInstanceRef = useRef<HTMLDivElement | null>(null);
  const themeInitializedRef = useRef(false);

  // Set global flag to prevent settingsStore from applying theme
  useEffect(() => {
    (window as any).__customThemeEditorOpen = isOpen;
    return () => {
      (window as any).__customThemeEditorOpen = false;
    };
  }, [isOpen]);

  // Load custom theme from settings only when editor first opens
  useEffect(() => {
    if (isOpen && !themeInitializedRef.current) {
      // Only initialize once when editor opens
      if (settings?.customTheme) {
        setTheme(settings.customTheme);
        // Determine app background mode based on whether gradient is set
        if (settings.customTheme.bgGradient && settings.customTheme.bgGradient !== DEFAULT_CUSTOM_THEME.bgGradient) {
          setAppBgMode('gradient');
        } else {
          setAppBgMode('solid');
        }
      } else {
        setTheme(DEFAULT_CUSTOM_THEME);
        setAppBgMode('gradient');
      }
      themeInitializedRef.current = true;
    } else if (!isOpen) {
      // Reset initialization flag when editor closes
      themeInitializedRef.current = false;
    }
  }, [isOpen, settings?.customTheme]);

  // Load recent colors from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('customThemeRecentColors');
    if (stored) {
      try {
        setRecentColors(JSON.parse(stored));
      } catch {
        setRecentColors([]);
      }
    }
  }, []);

  // Apply theme preview in real-time (only when editor is open)
  useEffect(() => {
    if (!isOpen) {
      return; // Don't restore theme when editor closes - let handleCancel handle that
    }
    
    // Apply the current theme state in real-time (synchronously to take priority)
    const root = document.documentElement;
    root.setAttribute('data-theme', 'custom');
    root.style.setProperty('color-scheme', 'dark');
    // Apply app background based on mode
    if (appBgMode === 'gradient') {
      root.style.setProperty('--app-bg-color', 'transparent'); // Use transparent when using gradient
      root.style.setProperty('--bg-gradient', theme.bgGradient);
      root.style.setProperty('--bg-pattern', theme.bgPattern);
      document.body.style.backgroundColor = 'transparent';
    } else {
      root.style.setProperty('--app-bg-color', theme.appBgColor);
      root.style.setProperty('--bg-gradient', 'none');
      root.style.setProperty('--bg-pattern', 'none');
      document.body.style.backgroundColor = theme.appBgColor;
    }
    
    root.style.setProperty('--app-text-color', theme.appTextColor);
    root.style.setProperty('--header-bg-color', theme.headerBgColor);
    root.style.setProperty('--border-color', theme.borderColor);
    root.style.setProperty('--card-bg-color', theme.cardBgColor);
    root.style.setProperty('--card-border-color', theme.cardBorderColor);
    root.style.setProperty('--text-secondary', theme.textSecondary);
    root.style.setProperty('--input-bg-color', theme.inputBgColor);
    root.style.setProperty('--input-border-color', theme.inputBorderColor);
    root.style.setProperty('--input-text-color', theme.inputTextColor);
    root.style.setProperty('--btn-secondary-bg', theme.btnSecondaryBg);
    root.style.setProperty('--btn-secondary-hover', theme.btnSecondaryHover);
    root.style.setProperty('--btn-secondary-text', theme.btnSecondaryText);
    root.style.setProperty('--btn-secondary-border', theme.btnSecondaryBorder);
    root.style.setProperty('--info-box-bg', theme.infoBoxBg);
    root.style.setProperty('--info-box-border', theme.infoBoxBorder);
    root.style.setProperty('--warning-box-bg', theme.warningBoxBg);
    root.style.setProperty('--warning-box-border', theme.warningBoxBorder);
    root.style.setProperty('--info-panel-bg', theme.infoPanelBg);
    root.style.setProperty('--info-panel-border', theme.infoPanelBorder);
    root.style.setProperty('--modal-overlay', theme.modalOverlay);
    root.style.setProperty('--update-version-color', theme.updateVersionColor);
    root.style.setProperty('--update-version-bg', theme.updateVersionBg);
    
    // Apply badge colors via CSS variables
    root.style.setProperty('--badge-gray', theme.badgeGray);
    root.style.setProperty('--badge-blue', theme.badgeBlue);
    root.style.setProperty('--badge-orange-red', theme.badgeOrangeRed);
    root.style.setProperty('--badge-yellow', theme.badgeYellow);
    root.style.setProperty('--badge-green', theme.badgeGreen);
    root.style.setProperty('--badge-red', theme.badgeRed);
    root.style.setProperty('--badge-orange', theme.badgeOrange);
    root.style.setProperty('--badge-cyan', theme.badgeCyan);
    root.style.setProperty('--primary-btn-color', theme.primaryBtnColor);
    root.style.setProperty('--primary-btn-hover', theme.primaryBtnHover);
    document.body.style.color = theme.appTextColor;
  }, [theme, isOpen, appBgMode]);

  const handleColorChange = (key: keyof CustomTheme, color: string) => {
    // Always update the theme state - the useEffect will apply it to CSS variables
    setTheme(prev => ({ ...prev, [key]: color }));
    
    // Add to recent colors
    setRecentColors(prev => {
      const updated = [color, ...prev.filter(c => c !== color)].slice(0, 10);
      localStorage.setItem('customThemeRecentColors', JSON.stringify(updated));
      return updated;
    });
  };

  const handleColorPickerClose = () => {
    colorPickerClosingRef.current = true;
    setEditingColor(null);
    // Reset flag after a short delay
    setTimeout(() => {
      colorPickerClosingRef.current = false;
    }, 100);
  };

  const handleSave = async () => {
    try {
      // Apply the theme immediately before saving to prevent flash
      const root = document.documentElement;
      root.setAttribute('data-theme', 'custom');
      root.style.setProperty('color-scheme', 'dark');
      
      // Apply app background based on mode
      if (appBgMode === 'gradient') {
        root.style.setProperty('--app-bg-color', 'transparent');
        root.style.setProperty('--bg-gradient', theme.bgGradient);
        root.style.setProperty('--bg-pattern', theme.bgPattern);
        document.body.style.backgroundColor = 'transparent';
      } else {
        root.style.setProperty('--app-bg-color', theme.appBgColor);
        root.style.setProperty('--bg-gradient', 'none');
        root.style.setProperty('--bg-pattern', 'none');
        document.body.style.backgroundColor = theme.appBgColor;
      }
      
      root.style.setProperty('--app-text-color', theme.appTextColor);
      root.style.setProperty('--header-bg-color', theme.headerBgColor);
      root.style.setProperty('--border-color', theme.borderColor);
      root.style.setProperty('--card-bg-color', theme.cardBgColor);
      root.style.setProperty('--card-border-color', theme.cardBorderColor);
      root.style.setProperty('--text-secondary', theme.textSecondary);
      root.style.setProperty('--input-bg-color', theme.inputBgColor);
      root.style.setProperty('--input-border-color', theme.inputBorderColor);
      root.style.setProperty('--input-text-color', theme.inputTextColor);
      root.style.setProperty('--btn-secondary-bg', theme.btnSecondaryBg);
      root.style.setProperty('--btn-secondary-hover', theme.btnSecondaryHover);
      root.style.setProperty('--btn-secondary-text', theme.btnSecondaryText);
      root.style.setProperty('--btn-secondary-border', theme.btnSecondaryBorder);
      root.style.setProperty('--info-box-bg', theme.infoBoxBg);
      root.style.setProperty('--info-box-border', theme.infoBoxBorder);
      root.style.setProperty('--warning-box-bg', theme.warningBoxBg);
      root.style.setProperty('--warning-box-border', theme.warningBoxBorder);
      root.style.setProperty('--info-panel-bg', theme.infoPanelBg);
      root.style.setProperty('--info-panel-border', theme.infoPanelBorder);
      root.style.setProperty('--modal-overlay', theme.modalOverlay);
      root.style.setProperty('--update-version-color', theme.updateVersionColor);
      root.style.setProperty('--update-version-bg', theme.updateVersionBg);
      root.style.setProperty('--badge-gray', theme.badgeGray);
      root.style.setProperty('--badge-blue', theme.badgeBlue);
      root.style.setProperty('--badge-orange-red', theme.badgeOrangeRed);
      root.style.setProperty('--badge-yellow', theme.badgeYellow);
      root.style.setProperty('--badge-green', theme.badgeGreen);
      root.style.setProperty('--badge-red', theme.badgeRed);
      root.style.setProperty('--badge-orange', theme.badgeOrange);
      root.style.setProperty('--badge-cyan', theme.badgeCyan);
      root.style.setProperty('--primary-btn-color', theme.primaryBtnColor);
      root.style.setProperty('--primary-btn-hover', theme.primaryBtnHover);
      document.body.style.color = theme.appTextColor;
      
      // Save the theme
      await updateSettings({ 
        theme: 'custom',
        customTheme: theme 
      });
      onClose();
    } catch (err) {
      console.error('Failed to save custom theme:', err);
    }
  };

  const handleCancel = async () => {
    // Restore the saved theme by refreshing settings, which will reapply the theme
    await refreshSettings();
    onClose();
  };

  const handleReset = () => {
    setTheme(DEFAULT_CUSTOM_THEME);
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="modal-overlay" onClick={onClose} />
      <div className="modal-content custom-theme-editor">
        <div className="modal-header">
          <h2>Custom Theme Editor</h2>
          <button className="btn-icon-small" onClick={onClose} title="Close">
            <i className="fas fa-times"></i>
          </button>
        </div>

        <div className="modal-body custom-theme-editor-body">
          {/* App Background Mode Toggle */}
          <div className="color-group">
            <h3>App Background Mode</h3>
            <div className="app-bg-mode-toggle">
              <button
                className={appBgMode === 'gradient' ? 'active' : ''}
                onClick={() => setAppBgMode('gradient')}
              >
                <i className="fas fa-palette"></i> Gradient/Pattern
              </button>
              <button
                className={appBgMode === 'solid' ? 'active' : ''}
                onClick={() => setAppBgMode('solid')}
              >
                <i className="fas fa-fill"></i> Solid Color
              </button>
            </div>
            {appBgMode === 'gradient' && (
              <div style={{ marginTop: '1rem', padding: '0.75rem', backgroundColor: 'var(--input-bg-color, rgba(26, 26, 26, 0.7))', borderRadius: 'clamp(0.375rem, 0.75vw, 0.5rem)', border: '1px solid var(--border-color, #3a3a3a)' }}>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary, #cccccc)' }}>
                  Use the Background Gradient and Pattern controls below to customize the app background.
                </p>
              </div>
            )}
          </div>

          {COLOR_GROUPS.map(group => (
            <div key={group.name} className="color-group">
              <h3>{group.name}</h3>
              <div className="color-group-grid">
                {group.colors.map(({ key, label }) => {
                  const isGradient = key === 'bgGradient';
                  const isAppBgColor = key === 'appBgColor';
                  const value = theme[key as keyof CustomTheme];
                  
                  // Hide app background color when in gradient mode
                  if (isAppBgColor && appBgMode === 'gradient') {
                    return null;
                  }
                  
                  // For bgGradient, show a combined preview with both gradient and pattern
                  let displayValue = value;
                  let displayStyle: React.CSSProperties = {};
                  if (isGradient) {
                    // Combine gradient and pattern for display
                    const gradient = theme.bgGradient as string;
                    const pattern = theme.bgPattern as string;
                    displayValue = pattern ? `${gradient}, ${pattern}` : gradient;
                    displayStyle = { background: displayValue as string };
                  } else {
                    displayStyle = { backgroundColor: value as string };
                  }
                  
                  return (
                    <div key={key} className="color-item">
                      <label>{label}</label>
                      <button
                        className="color-swatch"
                        style={displayStyle}
                        onClick={() => {
                          // Close any existing editors first
                          if (editingColor && editingColor !== key) {
                            handleColorPickerClose();
                          }
                          if (editingGradient && editingGradient !== key) {
                            setEditingGradient(null);
                          }
                          
                          if (isGradient) {
                            setEditingGradient(key);
                            // Determine initial mode based on which has a non-default value
                            const pattern = theme.bgPattern as string;
                            const defaultPattern = DEFAULT_CUSTOM_THEME.bgPattern;
                            if (pattern && pattern !== defaultPattern) {
                              setGradientEditMode('pattern');
                            } else {
                              setGradientEditMode('gradient');
                            }
                          } else {
                            setEditingColor(key);
                          }
                        }}
                      >
                        {isGradient ? (
                          <div className="gradient-preview-small" style={{ background: displayValue as string }} />
                        ) : (
                          <span className="color-value">{value}</span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="modal-footer" style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          padding: '1rem 1.25rem',
          borderTop: '1px solid var(--border-color, #3a3a3a)',
          flexShrink: 0
        }}>
          <button className="btn btn-secondary" onClick={handleReset}>
            Reset to Default
          </button>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-secondary" onClick={handleCancel}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleSave}>
              Save Theme
            </button>
          </div>
        </div>
      </div>

      {editingColor && (
        <div ref={colorPickerInstanceRef}>
          <ColorPicker
            key={editingColor} // Force remount when editing different color
            color={theme[editingColor as keyof CustomTheme]}
            onChange={(color) => handleColorChange(editingColor as keyof CustomTheme, color)}
            onClose={handleColorPickerClose}
            recentColors={recentColors}
          />
        </div>
      )}

      {editingGradient && (
        <GradientEditor
          gradient={gradientEditMode === 'pattern' 
            ? (theme.bgPattern as string)
            : (theme.bgGradient as string)
          }
          onChange={(gradient) => {
            if (gradientEditMode === 'pattern') {
              handleColorChange('bgPattern', gradient);
            } else {
              handleColorChange('bgGradient', gradient);
            }
          }}
          onClose={() => setEditingGradient(null)}
          editMode={gradientEditMode}
          onModeChange={setGradientEditMode}
        />
      )}
    </>
  );
}

