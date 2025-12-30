import React, { useState, useEffect, useRef } from 'react';

interface GradientEditorProps {
  gradient: string;
  onChange: (gradient: string) => void;
  onClose: () => void;
  editMode?: 'gradient' | 'pattern';
  onModeChange?: (mode: 'gradient' | 'pattern') => void;
}

const GRADIENT_PRESETS = [
  // Linear Gradients
  { name: 'Sunset', value: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
  { name: 'Ocean', value: 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%)' },
  { name: 'Forest', value: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)' },
  { name: 'Fire', value: 'linear-gradient(135deg, #f12711 0%, #f5af19 100%)' },
  { name: 'Cool Blue', value: 'linear-gradient(135deg, #0f0f0f 0%, #1a1a2e 25%, #16213e 50%, #0f3460 75%, #1a1a1a 100%)' },
  { name: 'Purple Dream', value: 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%)' },
  { name: 'Dark Night', value: 'linear-gradient(135deg, #0c0c0c 0%, #1a1a2e 50%, #16213e 100%)' },
  { name: 'Warm Sunset', value: 'linear-gradient(135deg, #f093fb 0%, #f5576c 50%, #4facfe 100%)' },
  { name: 'Emerald', value: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)' },
  { name: 'Royal', value: 'linear-gradient(135deg, #141e30 0%, #243b55 100%)' },
  
  // Radial Gradients
  { name: 'Radial Blue', value: 'radial-gradient(circle at 50% 50%, rgba(59, 130, 246, 0.3) 0%, transparent 70%)' },
  { name: 'Radial Purple', value: 'radial-gradient(circle at 50% 50%, rgba(139, 92, 246, 0.3) 0%, transparent 70%)' },
  { name: 'Radial Glow', value: 'radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.1) 0%, transparent 70%)' },
];

const PATTERN_PRESETS = [
  { name: 'Subtle Blue', value: 'radial-gradient(circle at 20% 30%, rgba(79, 70, 229, 0.08) 0%, transparent 50%), radial-gradient(circle at 80% 70%, rgba(139, 92, 246, 0.08) 0%, transparent 50%)' },
  { name: 'Dual Glow', value: 'radial-gradient(circle at 10% 20%, rgba(59, 130, 246, 0.15) 0%, transparent 50%), radial-gradient(circle at 90% 80%, rgba(99, 102, 241, 0.15) 0%, transparent 50%)' },
  { name: 'Triple Glow', value: 'radial-gradient(circle at 10% 20%, rgba(59, 130, 246, 0.15) 0%, transparent 50%), radial-gradient(circle at 90% 80%, rgba(99, 102, 241, 0.15) 0%, transparent 50%), radial-gradient(circle at 50% 50%, rgba(139, 92, 246, 0.1) 0%, transparent 50%)' },
  { name: 'Quad Glow', value: 'radial-gradient(circle at 10% 20%, rgba(59, 130, 246, 0.15) 0%, transparent 50%), radial-gradient(circle at 90% 80%, rgba(99, 102, 241, 0.15) 0%, transparent 50%), radial-gradient(circle at 50% 50%, rgba(139, 92, 246, 0.1) 0%, transparent 50%), radial-gradient(circle at 30% 70%, rgba(37, 99, 235, 0.12) 0%, transparent 50%)' },
  { name: 'Warm Glow', value: 'radial-gradient(circle at 20% 50%, rgba(147, 197, 253, 0.3) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(251, 207, 232, 0.3) 0%, transparent 50%)' },
  { name: 'Cool Glow', value: 'radial-gradient(circle at 20% 30%, rgba(79, 70, 229, 0.08) 0%, transparent 50%), radial-gradient(circle at 80% 70%, rgba(139, 92, 246, 0.08) 0%, transparent 50%), radial-gradient(circle at 50% 50%, rgba(99, 102, 241, 0.06) 0%, transparent 50%)' },
  { name: 'Soft Light', value: 'radial-gradient(circle at 30% 40%, rgba(255, 255, 255, 0.05) 0%, transparent 60%), radial-gradient(circle at 70% 60%, rgba(255, 255, 255, 0.03) 0%, transparent 60%)' },
  { name: 'Color Burst', value: 'radial-gradient(circle at 20% 30%, rgba(59, 130, 246, 0.2) 0%, transparent 40%), radial-gradient(circle at 80% 70%, rgba(139, 92, 246, 0.2) 0%, transparent 40%), radial-gradient(circle at 50% 50%, rgba(99, 102, 241, 0.15) 0%, transparent 40%)' },
];

export function GradientEditor({ gradient, onChange, onClose, editMode = 'gradient', onModeChange }: GradientEditorProps) {
  const [gradientValue, setGradientValue] = useState(gradient);
  const [gradientType, setGradientType] = useState<'linear' | 'radial'>('linear');
  const [direction, setDirection] = useState('135deg');
  const [directionDegrees, setDirectionDegrees] = useState(135);
  const [stops, setStops] = useState<Array<{ color: string; position: number }>>([]);
  const isInitialMount = useRef(true);
  
  // Detect if this is a pattern (multiple radial gradients) - make it reactive
  const isPattern = gradient.includes('radial-gradient') && (gradient.match(/radial-gradient/g) || []).length > 1;

  // Parse gradient on mount and when gradient prop or editMode changes
  useEffect(() => {
    // Reset initial mount flag when gradient prop or mode changes
    isInitialMount.current = true;
    // Always set the gradient value first to ensure preview shows immediately
    setGradientValue(gradient);
    // Then parse it to populate the controls
    parseGradient(gradient);
  }, [gradient, editMode]);

  // Update gradient value when components change (but not on initial mount when parsing)
  useEffect(() => {
    // Skip on initial mount - let parseGradient handle it
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    
    // If it's a pattern, preserve the original value
    if (isPattern && gradient) {
      setGradientValue(gradient);
      onChange(gradient);
      return;
    }
    
    if (stops.length > 0) {
      const stopsStr = stops.map(s => `${s.color} ${s.position}%`).join(', ');
      let newGradient = '';
      
      if (gradientType === 'linear') {
        newGradient = `linear-gradient(${direction}, ${stopsStr})`;
      } else {
        // For radial gradients, we'll use a simple format
        // More complex radial gradients can be edited manually
        newGradient = `radial-gradient(circle at 50% 50%, ${stopsStr})`;
      }
      
      setGradientValue(newGradient);
      onChange(newGradient);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gradientType, direction, stops, isPattern]);

  const parseGradient = (grad: string) => {
    // Always ensure gradientValue is set for preview
    setGradientValue(grad);
    
    // Check if this is a pattern (multiple radial gradients) - handle first
    const patternMatch = grad.match(/radial-gradient/g);
    if (patternMatch && patternMatch.length > 1) {
      // This is a pattern, preserve it as-is and don't try to parse
      setGradientType('radial');
      // Set default stops for display (won't be used for patterns)
      setStops([
        { color: '#000000', position: 0 },
        { color: '#ffffff', position: 100 }
      ]);
      return;
    }
    
    // Parse linear-gradient
    const linearMatch = grad.match(/linear-gradient\(([^)]+)\)/);
    if (linearMatch) {
      setGradientType('linear');
      const content = linearMatch[1];
      // Extract direction (first value before comma)
      const parts = content.split(',');
      const firstPart = parts[0].trim();
      const directionMatch = firstPart.match(/(\d+deg|to\s+\w+)/);
      if (directionMatch) {
        const dirValue = directionMatch[1];
        setDirection(dirValue);
        // Extract degrees from direction
        const degMatch = dirValue.match(/(\d+)deg/);
        if (degMatch) {
          setDirectionDegrees(Number(degMatch[1]));
        } else {
          // Default to 135deg if no numeric value found
          setDirectionDegrees(135);
        }
      } else {
        // Default direction if not found
        setDirection('135deg');
        setDirectionDegrees(135);
      }
      
      // Parse color stops - improved regex to handle hex, rgb, rgba, and named colors
      const stopParts = parts.slice(1);
      const parsedStops = stopParts.map((part, idx) => {
        const trimmed = part.trim();
        // Match color (hex, rgb, rgba, or named) followed by optional position
        // Pattern: color value (can be complex) followed by optional percentage
        const colorMatch = trimmed.match(/^(.+?)(?:\s+(\d+)%)?$/);
        if (colorMatch) {
          const color = colorMatch[1].trim();
          const position = colorMatch[2] ? parseInt(colorMatch[2]) : (idx === 0 ? 0 : 100);
          // Validate that it looks like a color (starts with #, rgb, rgba, or is a valid color name)
          if (color.match(/^(#[0-9a-fA-F]{3,8}|rgb\(|rgba\(|[a-zA-Z]+)$/)) {
            return { color, position };
          }
        }
        // Fallback: try to extract just the color part
        const simpleMatch = trimmed.match(/^([^0-9%]+?)(?:\s+(\d+)%)?$/);
        if (simpleMatch) {
          return {
            color: simpleMatch[1].trim(),
            position: simpleMatch[2] ? parseInt(simpleMatch[2]) : (idx === 0 ? 0 : 100)
          };
        }
        return { color: '#000000', position: idx === 0 ? 0 : 100 };
      });
      if (parsedStops.length > 0) {
        setStops(parsedStops);
      } else {
        // Default stops if parsing fails
        setStops([
          { color: '#000000', position: 0 },
          { color: '#ffffff', position: 100 }
        ]);
      }
      return;
    }

    // Parse single radial-gradient
    const radialMatch = grad.match(/radial-gradient\([^,]+,\s*(.+)\)/);
    if (radialMatch) {
      setGradientType('radial');
      const content = radialMatch[1];
      const parts = content.split(',');
      const parsedStops = parts.map((part, idx) => {
        const trimmed = part.trim();
        // Improved color matching
        const colorMatch = trimmed.match(/^(.+?)(?:\s+(\d+)%)?$/);
        if (colorMatch) {
          const color = colorMatch[1].trim();
          const position = colorMatch[2] ? parseInt(colorMatch[2]) : (idx === 0 ? 0 : 100);
          if (color.match(/^(#[0-9a-fA-F]{3,8}|rgb\(|rgba\(|[a-zA-Z]+)$/)) {
            return { color, position };
          }
        }
        // Fallback
        const simpleMatch = trimmed.match(/^([^0-9%]+?)(?:\s+(\d+)%)?$/);
        if (simpleMatch) {
          return {
            color: simpleMatch[1].trim(),
            position: simpleMatch[2] ? parseInt(simpleMatch[2]) : (idx === 0 ? 0 : 100)
          };
        }
        return { color: '#000000', position: idx === 0 ? 0 : 100 };
      });
      if (parsedStops.length > 0) {
        setStops(parsedStops);
      } else {
        setStops([
          { color: '#000000', position: 0 },
          { color: '#ffffff', position: 100 }
        ]);
      }
      return;
    }

    // If parsing fails completely, preserve the original gradient value
    // (gradientValue is already set at the start of the function)
    setStops([
      { color: '#000000', position: 0 },
      { color: '#ffffff', position: 100 }
    ]);
  };

  const addStop = () => {
    const newPosition = stops.length > 0 
      ? Math.min(100, stops[stops.length - 1].position + 10)
      : 50;
    setStops([...stops, { color: '#808080', position: newPosition }].sort((a, b) => a.position - b.position));
  };

  const removeStop = (index: number) => {
    if (stops.length > 2) {
      setStops(stops.filter((_, i) => i !== index));
    }
  };

  const updateStop = (index: number, field: 'color' | 'position', value: string | number) => {
    const newStops = [...stops];
    newStops[index] = { ...newStops[index], [field]: value };
    setStops(newStops.sort((a, b) => a.position - b.position));
  };

  const directions = [
    { value: '0deg', label: '→' },
    { value: '45deg', label: '↗' },
    { value: '90deg', label: '↑' },
    { value: '135deg', label: '↖' },
    { value: '180deg', label: '←' },
    { value: '225deg', label: '↙' },
    { value: '270deg', label: '↓' },
    { value: '315deg', label: '↘' },
  ];

  return (
    <div className="color-picker-overlay" onClick={onClose}>
      <div className="color-picker gradient-editor" onClick={(e) => e.stopPropagation()}>
        <div className="color-picker-header">
          <div className="gradient-header-content">
            <h3>Edit Gradient</h3>
            {onModeChange && (
              <div className="gradient-mode-switch">
                <button
                  className={editMode === 'gradient' ? 'active' : ''}
                  onClick={() => onModeChange('gradient')}
                  title="Edit Gradient"
                >
                  Gradient
                </button>
                <button
                  className={editMode === 'pattern' ? 'active' : ''}
                  onClick={() => onModeChange('pattern')}
                  title="Edit Pattern"
                >
                  Pattern
                </button>
              </div>
            )}
          </div>
          <button className="btn-icon-small" onClick={onClose} title="Close">
            <i className="fas fa-times"></i>
          </button>
        </div>

        <div className="color-picker-content">
          <div className="gradient-main-layout">
            <div className="gradient-left-column">
              {/* Gradient Preview */}
              <div className="gradient-control-group">
                <label>Preview</label>
                <div 
                  className="gradient-preview"
                  style={{ background: gradientValue || gradient || 'linear-gradient(135deg, #000000 0%, #ffffff 100%)' }}
                />
              </div>

              {/* Presets Section */}
              <div className="gradient-control-group gradient-presets-group">
                <label>Presets</label>
                <div className="gradient-presets">
                  {editMode === 'gradient' ? (
                    <div className="preset-section">
                      <label className="preset-section-label">Gradients</label>
                      <div className="preset-grid">
                        {GRADIENT_PRESETS.map((preset, index) => (
                          <button
                            key={index}
                            className="preset-item"
                            onClick={() => {
                              setGradientValue(preset.value);
                              onChange(preset.value);
                              parseGradient(preset.value);
                            }}
                            title={preset.name}
                          >
                            <div 
                              className="preset-preview"
                              style={{ background: preset.value }}
                            />
                            <span className="preset-name">{preset.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="preset-section">
                      <label className="preset-section-label">Patterns</label>
                      <div className="preset-grid">
                        {PATTERN_PRESETS.map((preset, index) => (
                          <button
                            key={index}
                            className="preset-item"
                            onClick={() => {
                              setGradientValue(preset.value);
                              onChange(preset.value);
                              parseGradient(preset.value);
                            }}
                            title={preset.name}
                          >
                            <div 
                              className="preset-preview"
                              style={{ background: preset.value }}
                            />
                            <span className="preset-name">{preset.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="gradient-right-column">
              {/* Gradient Type and Direction (inline) */}
              <div className="gradient-control-group">
                <div className="gradient-type-direction-inline">
                  <div className="gradient-type-section">
                    <label>Type</label>
                    <div className="gradient-type-buttons">
                      <button
                        className={gradientType === 'linear' ? 'active' : ''}
                        onClick={() => setGradientType('linear')}
                      >
                        Linear
                      </button>
                      <button
                        className={gradientType === 'radial' ? 'active' : ''}
                        onClick={() => setGradientType('radial')}
                      >
                        Radial
                      </button>
                    </div>
                  </div>

                  {/* Direction (for linear gradients) */}
                  {gradientType === 'linear' && (
                    <div className="gradient-direction-section">
                      <label>Direction</label>
                      <div className="gradient-direction-controls">
                        <div className="gradient-direction-buttons">
                          {directions.map(dir => (
                            <button
                              key={dir.value}
                              className={direction === dir.value ? 'active' : ''}
                              onClick={() => {
                                const deg = parseInt(dir.value);
                                setDirection(dir.value);
                                setDirectionDegrees(isNaN(deg) ? 135 : deg);
                              }}
                              title={dir.value}
                            >
                              {dir.label}
                            </button>
                          ))}
                        </div>
                        <div className="gradient-direction-slider-group">
                          <input
                            type="range"
                            min="0"
                            max="360"
                            value={directionDegrees}
                            onChange={(e) => {
                              const deg = Number(e.target.value);
                              setDirectionDegrees(deg);
                              setDirection(`${deg}deg`);
                            }}
                            className="gradient-direction-slider"
                          />
                          <input
                            type="number"
                            min="0"
                            max="360"
                            value={directionDegrees}
                            onChange={(e) => {
                              const deg = Number(e.target.value);
                              setDirectionDegrees(deg);
                              setDirection(`${deg}deg`);
                            }}
                            className="gradient-direction-input"
                          />
                          <span>°</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Color Stops */}
              <div className="gradient-control-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <label>Color Stops</label>
                  <button className="btn btn-secondary btn-small" onClick={addStop}>
                    <i className="fas fa-plus"></i> Add Stop
                  </button>
                </div>
                <div className="gradient-stops">
                  {stops.map((stop, index) => (
                    <div key={index} className="gradient-stop-item">
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flex: '1', minWidth: 0 }}>
                    <input
                      type="color"
                      value={(() => {
                        // Try to extract hex from the color value
                        const hexMatch = stop.color.match(/#([0-9a-fA-F]{6})/);
                        if (hexMatch) {
                          return `#${hexMatch[1]}`;
                        }
                        // Try to convert rgb/rgba to hex if possible
                        const rgbMatch = stop.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                        if (rgbMatch) {
                          const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
                          const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
                          const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
                          return `#${r}${g}${b}`;
                        }
                        return '#000000';
                      })()}
                      onChange={(e) => updateStop(index, 'color', e.target.value)}
                      className="gradient-stop-color"
                      title={stop.color}
                    />
                    <input
                      type="text"
                      value={stop.color}
                      onChange={(e) => updateStop(index, 'color', e.target.value)}
                      className="gradient-stop-color-text"
                      placeholder="#000000 or rgba(...)"
                      title="Color value (hex, rgb, rgba, or named)"
                    />
                  </div>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={stop.position}
                        onChange={(e) => updateStop(index, 'position', Number(e.target.value))}
                        className="gradient-stop-position"
                      />
                      <span style={{ minWidth: '20px' }}>%</span>
                      {stops.length > 2 && (
                        <button
                          className="btn-icon-small"
                          onClick={() => removeStop(index)}
                          title="Remove stop"
                        >
                          <i className="fas fa-times"></i>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Manual Edit - Full Width */}
        <div className="gradient-manual-edit-container">
          <label>Manual Edit (CSS)</label>
          <textarea
            value={gradientValue}
            onChange={(e) => {
              setGradientValue(e.target.value);
              onChange(e.target.value);
            }}
            className="gradient-manual-edit"
            rows={2}
            placeholder="linear-gradient(135deg, #000 0%, #fff 100%)"
          />
        </div>
      </div>
    </div>
  );
}

