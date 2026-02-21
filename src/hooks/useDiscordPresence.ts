import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Discord Application ID
const DISCORD_APP_ID = '1463445310499065927';

// Track initialization to prevent duplicate calls
let hasInitialized = false;

export const useDiscordPresence = () => {
  useEffect(() => {
    // Prevent multiple initializations
    if (hasInitialized) {
      return;
    }
    hasInitialized = true;

    console.log('[Discord] Setting up static presence...');

    // Initialize Discord with static presence
    const initDiscord = async () => {
      try {
        await invoke('discord_initialize', { 
          applicationId: DISCORD_APP_ID 
        });
        console.log('[Discord] Static presence active: Schedule I Mod Manager (SIMM)');
      } catch (error) {
        console.error('[Discord] Failed to initialize:', error);
      }
    };

    // Small delay to ensure Discord IPC is ready
    setTimeout(() => {
      initDiscord();
    }, 2000);

    // Cleanup on app close
    return () => {
      invoke('discord_shutdown').catch(console.error);
    };
  }, []);
};
