import React, { useState, useEffect } from 'react';
import { useEnvironmentStore } from '../stores/environmentStore';
import { logger } from '../services/logger';
import { lastUpdateCheckTimeRef } from './EnvironmentList';

// Version injected at build time by Vite
declare const __APP_VERSION__: string;
const APP_VERSION = __APP_VERSION__;

export function Footer() {
  const { environments, checkAllUpdates } = useEnvironmentStore();
  const [checkingAll, setCheckingAll] = useState(false);
  const [currentTime, setCurrentTime] = useState(Date.now());
  
  // Update current time every 30 seconds to refresh the "Last check" display
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 30000); // Update every 30 seconds
    
    return () => clearInterval(interval);
  }, []);
  
  // Recalculate most recent check whenever environments change

  // Calculate update check statistics
  const completedEnvs = environments.filter(env => env.status === 'completed');
  const envsWithUpdates = completedEnvs.filter(env => env.updateAvailable);
  const envsChecked = completedEnvs.filter(env => env.lastUpdateCheck);
  
  // Get the most recent update check time (handle both string and number timestamps)
  const mostRecentCheck = envsChecked.length > 0
    ? envsChecked.reduce((latest, env) => {
        if (!env.lastUpdateCheck) return latest;
        
        // Convert to timestamp (milliseconds) for comparison
        let envCheckTime: number;
        if (typeof env.lastUpdateCheck === 'number') {
          envCheckTime = env.lastUpdateCheck < 946684800000 
            ? env.lastUpdateCheck * 1000 // Convert seconds to milliseconds
            : env.lastUpdateCheck; // Already in milliseconds
        } else {
          envCheckTime = new Date(env.lastUpdateCheck).getTime();
        }
        
        let latestTime: number;
        if (latest) {
          if (typeof latest === 'number') {
            latestTime = latest < 946684800000 ? latest * 1000 : latest;
          } else {
            latestTime = new Date(latest).getTime();
          }
        } else {
          latestTime = 0;
        }
        
        return envCheckTime > latestTime ? env.lastUpdateCheck : latest;
      }, envsChecked[0].lastUpdateCheck || null)
    : null;

  const formatLastCheck = (dateValue?: string | number) => {
    if (!dateValue) return 'Never';
    try {
      // Handle both string dates and timestamp numbers (seconds or milliseconds)
      let date: Date;
      if (typeof dateValue === 'number') {
        // If it's a number, check if it's seconds (less than year 2000 in ms) or milliseconds
        // Timestamps after 2000-01-01 in seconds would be > 946684800
        // Timestamps after 2000-01-01 in milliseconds would be > 946684800000
        date = dateValue < 946684800000 
          ? new Date(dateValue * 1000) // Convert seconds to milliseconds
          : new Date(dateValue); // Already in milliseconds
      } else {
        date = new Date(dateValue);
      }
      
      // Check if date is valid
      if (isNaN(date.getTime())) {
        return 'Invalid date';
      }
      
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
      if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
      if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
      return date.toLocaleDateString();
    } catch {
      return 'Invalid date';
    }
  };

  const handleCheckAllUpdates = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    logger.info('Footer: Check updates button clicked');
    console.log('Footer: Check updates button clicked (console)');
    
    // Check all registered environments, not just completed ones
    const allEnvs = environments.filter(env => env.status !== 'error');
    logger.debug(`Footer: Found ${allEnvs.length} environments to check (excluding errors)`, { 
      totalEnvs: environments.length,
      validEnvs: allEnvs.length 
    });
    
    if (checkingAll) {
      logger.warn('Footer: Already checking updates, ignoring click');
      return;
    }
    
    if (allEnvs.length === 0) {
      logger.warn('Footer: No environments to check');
      return;
    }
    
    logger.info(`Footer: Starting update check for ${allEnvs.length} environment(s)`);
    
    try {
      setCheckingAll(true);
      logger.info('Footer: Calling checkAllUpdates from store...');
      // Update last check time before calling (manual check bypasses interval)
      lastUpdateCheckTimeRef.current = Date.now();
      await checkAllUpdates();
      logger.info('Footer: Update check completed successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logger.error(`Footer: Update check failed - ${errorMessage}`, { 
        error: err instanceof Error ? err.stack : String(err),
        environmentCount: allEnvs.length
      });
      // Errors are now logged to the backend log file, not shown to user
    } finally {
      setCheckingAll(false);
      logger.debug('Footer: Reset checkingAll state');
    }
  };

  return (
    <footer className="app-footer">
      <div className="footer-content">
        <div className="footer-section footer-update-info">
          <div className="footer-update-stats">
            <span className="footer-stat">
              <i className="fas fa-download" style={{ marginRight: '0.5rem' }}></i>
              {completedEnvs.length} game install{completedEnvs.length !== 1 ? 's' : ''} ready
            </span>
            {envsWithUpdates.length > 0 && (
              <span className="footer-stat footer-stat-update">
                <i className="fas fa-exclamation-circle" style={{ marginRight: '0.5rem' }}></i>
                {envsWithUpdates.length} update{envsWithUpdates.length !== 1 ? 's' : ''} available
              </span>
            )}
            <span className="footer-stat">
              {checkingAll ? (
                <>
                  <i className="fas fa-clock" style={{ marginRight: '0.5rem' }}></i>
                  Checking<span className="checking-dots"></span>
                </>
              ) : mostRecentCheck ? (
                <>
                  <i className="fas fa-clock" style={{ marginRight: '0.5rem' }}></i>
                  Last check: {formatLastCheck(mostRecentCheck)}
                </>
              ) : (
                <>
                  <i className="fas fa-clock" style={{ marginRight: '0.5rem' }}></i>
                  Last check: Never
                </>
              )}
            </span>
            {environments.length > 0 && (
              <button
                onClick={(e) => {
                  logger.debug('Footer: Button onClick event fired');
                  console.log('Footer: Button onClick event fired (console)');
                  handleCheckAllUpdates(e);
                }}
                onMouseDown={(e) => {
                  logger.debug('Footer: Button onMouseDown event fired');
                  console.log('Footer: Button onMouseDown event fired (console)');
                }}
                className="btn btn-icon-small footer-check-updates-btn"
                disabled={checkingAll}
                title="Check branches for updates"
                type="button"
                aria-label="Check branches for updates"
              >
                <i className={`fas ${checkingAll ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`}></i>
              </button>
            )}
          </div>
        </div>
        <div className="footer-section footer-copyright">
          <p>
            Copyright (c) 2025 SirTidez | <span className="footer-app-name">Schedule I Mod Manager</span> v{APP_VERSION}
          </p>
        </div>
      </div>
    </footer>
  );
}

