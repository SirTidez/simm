import React, { useState, useRef, useEffect } from 'react';

interface ColorPickerProps {
  color: string;
  onChange: (color: string) => void;
  onClose: () => void;
  recentColors?: string[];
}

// Global ref to track if a color picker is open
let activeColorPickerRef: { current: boolean } = { current: false };

// Convert hex/rgb to HSL helper (moved outside component for initialization)
const hexToHslHelper = (hex: string): [number, number, number, number] => {
  // Remove # if present
  hex = hex.replace('#', '');
  
  // Handle rgba
  if (hex.includes('rgba')) {
    const match = hex.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (match) {
      const r = parseInt(match[1]) / 255;
      const g = parseInt(match[2]) / 255;
      const b = parseInt(match[3]) / 255;
      const a = match[4] ? parseFloat(match[4]) : 1;
      const [h, s, l] = rgbToHslHelper(r, g, b);
      return [h, s, l, a];
    }
  }
  
  // Handle hex
  if (hex.length === 3) {
    hex = hex.split('').map(c => c + c).join('');
  }
  
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const [h, s, l] = rgbToHslHelper(r, g, b);
  return [h, s, l, 1];
};

const rgbToHslHelper = (r: number, g: number, b: number): [number, number, number] => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [h * 360, s * 100, l * 100];
};

export function ColorPicker({ color, onChange, onClose, recentColors = [] }: ColorPickerProps) {
  // Initialize state from color prop immediately
  const initialHsl = (() => {
    try {
      return hexToHslHelper(color);
    } catch {
      return [0, 100, 50, 1] as [number, number, number, number];
    }
  })();
  
  const [hue, setHue] = useState(initialHsl[0]);
  const [saturation, setSaturation] = useState(initialHsl[1]);
  const [lightness, setLightness] = useState(initialHsl[2]);
  const [alpha, setAlpha] = useState(initialHsl[3]);
  const [hexInput, setHexInput] = useState(color);
  const pickerRef = useRef<HTMLDivElement>(null);
  const hueBarRef = useRef<HTMLDivElement>(null);
  const alphaBarRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const isUpdatingRef = useRef(false);

  // Ensure only one color picker is open at a time
  useEffect(() => {
    if (activeColorPickerRef.current) {
      // Another picker is already open, close this one
      onClose();
      return;
    }
    activeColorPickerRef.current = true;
    
    return () => {
      activeColorPickerRef.current = false;
    };
  }, [onClose]);

  // Convert hex/rgb to HSL (using helper function)
  const hexToHsl = hexToHslHelper;

  // Convert HSL to hex
  const hslToHex = (h: number, s: number, l: number, a: number = 1): string => {
    if (a < 1) {
      return `rgba(${Math.round(hslToRgb(h, s, l).r)}, ${Math.round(hslToRgb(h, s, l).g)}, ${Math.round(hslToRgb(h, s, l).b)}, ${a})`;
    }
    const rgb = hslToRgb(h, s, l);
    return `#${[rgb.r, rgb.g, rgb.b].map(x => {
      const hex = Math.round(x).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('')}`;
  };

  const hslToRgb = (h: number, s: number, l: number) => {
    h /= 360;
    s /= 100;
    l /= 100;
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    return { r: r * 255, g: g * 255, b: b * 255 };
  };

  // Update from color prop when it changes externally (but not during user interaction)
  useEffect(() => {
    // Skip if we're in the middle of an update or dragging
    if (isUpdatingRef.current || isDraggingRef.current) {
      return;
    }
    
    try {
      const [h, s, l, a] = hexToHsl(color);
      // Only update if values actually changed to prevent loops
      const threshold = 0.5; // Small threshold to account for rounding
      if (Math.abs(h - hue) > threshold || Math.abs(s - saturation) > threshold || 
          Math.abs(l - lightness) > threshold || Math.abs(a - alpha) > 0.01) {
        isUpdatingRef.current = true;
        setHue(h);
        setSaturation(s);
        setLightness(l);
        setAlpha(a);
        setHexInput(color);
        // Reset flag after state updates
        requestAnimationFrame(() => {
          isUpdatingRef.current = false;
        });
      }
    } catch {
      // Invalid color, ignore
    }
  }, [color, hue, saturation, lightness, alpha]); // Include HSL in deps to detect changes

  // Update color when HSL changes (debounced to prevent rapid flashing)
  useEffect(() => {
    // Skip if we're initializing from color prop
    if (isUpdatingRef.current) {
      return;
    }
    
    const newColor = hslToHex(hue, saturation, lightness, alpha);
    // Only update if color actually changed
    if (newColor !== hexInput && newColor !== color) {
      setHexInput(newColor);
      // Use requestAnimationFrame to batch updates and prevent flashing
      requestAnimationFrame(() => {
        onChange(newColor);
      });
    }
  }, [hue, saturation, lightness, alpha]); // Removed hexInput and onChange from deps

  const handleSaturationLightnessMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    updateSaturationLightness(e);
    
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingRef.current) {
        e.preventDefault();
        updateSaturationLightness(e);
      }
    };
    
    const handleMouseUp = (e: MouseEvent) => {
      e.preventDefault();
      isDraggingRef.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const updateSaturationLightness = (e: React.MouseEvent | MouseEvent) => {
    if (!pickerRef.current) return;
    const rect = pickerRef.current.getBoundingClientRect();
    // Calculate position relative to the picker area, with proper bounds checking
    const rawX = (e.clientX - rect.left) / rect.width;
    const rawY = (e.clientY - rect.top) / rect.height;
    // Clamp to 0-1 range to prevent any values outside bounds
    const x = Math.max(0, Math.min(1, rawX));
    const y = Math.max(0, Math.min(1, rawY));
    // Convert to saturation (0-100%) and lightness (0-100%)
    // Note: In HSL, lightness 0% = black, lightness 100% = white, regardless of saturation
    setSaturation(x * 100);
    setLightness((1 - y) * 100);
  };

  const handleHueMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    const updateHue = (e: MouseEvent | React.MouseEvent) => {
      if (!hueBarRef.current) return;
      const hueRect = hueBarRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - hueRect.left) / hueRect.width));
      setHue(x * 360);
    };
    
    updateHue(e);
    
    const handleMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      updateHue(e);
    };
    
    const handleMouseUp = (e: MouseEvent) => {
      e.preventDefault();
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleAlphaMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    
    const updateAlpha = (e: MouseEvent | React.MouseEvent) => {
      if (!alphaBarRef.current) return;
      const alphaRect = alphaBarRef.current.getBoundingClientRect();
      const rawX = (e.clientX - alphaRect.left) / alphaRect.width;
      const x = Math.max(0, Math.min(1, rawX));
      setAlpha(x);
    };
    
    updateAlpha(e);
    
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingRef.current) {
        e.preventDefault();
        updateAlpha(e);
      }
    };
    
    const handleMouseUp = (e: MouseEvent) => {
      e.preventDefault();
      isDraggingRef.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleHexInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setHexInput(value);
    try {
      const [h, s, l, a] = hexToHsl(value);
      setHue(h);
      setSaturation(s);
      setLightness(l);
      setAlpha(a);
      onChange(value);
    } catch {
      // Invalid hex, ignore
    }
  };

  const currentColor = hslToHex(hue, saturation, lightness, alpha);

  return (
    <div className="color-picker-overlay" onClick={onClose}>
      <div className="color-picker" onClick={(e) => e.stopPropagation()}>
        <div className="color-picker-header">
          <h3>Pick a Color</h3>
          <button className="btn-icon-small" onClick={onClose} title="Close">
            <i className="fas fa-times"></i>
          </button>
        </div>
        
        <div className="color-picker-content">
          <div 
            ref={pickerRef}
            className="saturation-lightness-picker"
            style={{
              background: `linear-gradient(to top, black, transparent), linear-gradient(to right, white, hsl(${hue}, 100%, 50%))`
            }}
            onMouseDown={handleSaturationLightnessMouseDown}
          >
              <div 
                className="picker-handle"
                style={{
                  left: `${Math.max(0, Math.min(100, Math.max(0, Math.min(100, saturation))))}%`,
                  top: `${Math.max(0, Math.min(100, Math.max(0, Math.min(100, 100 - lightness))))}%`,
                  backgroundColor: currentColor,
                  borderColor: lightness > 50 ? 'rgba(0, 0, 0, 0.5)' : 'rgba(255, 255, 255, 0.9)'
                }}
              />
          </div>

          <div className="hue-bar-container">
            <div 
              ref={hueBarRef}
              className="hue-bar"
              style={{
                background: 'linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)'
              }}
              onMouseDown={handleHueMouseDown}
            >
              <div 
                className="hue-handle"
                style={{ left: `${(hue / 360) * 100}%` }}
              />
            </div>
          </div>

          <div className="alpha-bar-container">
            <div 
              ref={alphaBarRef}
              className="alpha-bar"
              style={{
                '--alpha-bar-color': hslToHex(hue, saturation, lightness, 1)
              } as React.CSSProperties}
              onMouseDown={handleAlphaMouseDown}
            >
              <div 
                className="alpha-handle"
                style={{ left: `${Math.max(0, Math.min(100, alpha * 100))}%`, zIndex: 2 }}
              />
            </div>
          </div>

          <div className="color-picker-controls">
            <div className="color-preview-wrapper">
              <div className="color-preview-checkerboard" />
              <div className="color-preview" style={{ backgroundColor: currentColor }} />
            </div>
            <div className="color-inputs">
              <div className="color-input-group color-input-hex">
                <label>Hex</label>
                <input
                  type="text"
                  value={hexInput}
                  onChange={handleHexInputChange}
                  className="color-input"
                  placeholder="#000000"
                />
              </div>
            </div>
            <div className="color-inputs-hsl">
              <div className="color-input-group">
                <label>H</label>
                <input
                  type="number"
                  min="0"
                  max="360"
                  value={Math.round(hue)}
                  onChange={(e) => setHue(Number(e.target.value))}
                  className="color-input"
                />
              </div>
              <div className="color-input-group">
                <label>S</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={Math.round(saturation)}
                  onChange={(e) => setSaturation(Number(e.target.value))}
                  className="color-input"
                />
              </div>
              <div className="color-input-group">
                <label>L</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={Math.round(lightness)}
                  onChange={(e) => setLightness(Number(e.target.value))}
                  className="color-input"
                />
              </div>
              <div className="color-input-group">
                <label>A</label>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={alpha.toFixed(2)}
                  onChange={(e) => setAlpha(Math.max(0, Math.min(1, Number(e.target.value))))}
                  className="color-input"
                />
              </div>
            </div>
          </div>

          {recentColors.length > 0 && (
            <div className="recent-colors">
              <label>Recent Colors</label>
              <div className="recent-colors-list">
                {recentColors.map((c, i) => (
                  <button
                    key={i}
                    className="recent-color-swatch"
                    style={{ backgroundColor: c }}
                    onClick={() => {
                      try {
                        const [h, s, l, a] = hexToHsl(c);
                        setHue(h);
                        setSaturation(s);
                        setLightness(l);
                        setAlpha(a);
                      } catch {}
                    }}
                    title={c}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="color-picker-footer">
          <button className="btn btn-secondary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

