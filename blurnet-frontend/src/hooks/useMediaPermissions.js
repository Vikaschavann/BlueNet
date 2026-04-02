/**
 * useMediaPermissions Hook
 * 
 * Provides lazy, on-demand getUserMedia() requests with proper state management.
 * - No permissions requested on initialization
 * - User CAN join room WITHOUT granting permissions
 * - Only calls getUserMedia when user explicitly clicks "Enable Mic/Camera"
 * - Handles permission denial gracefully
 */

import { useCallback, useRef, useState } from 'react';

export function useMediaPermissions() {
  const [permissionState, setPermissionState] = useState('idle'); // idle | requesting | granted | denied | error
  const [permissionError, setPermissionError] = useState('');
  const permissionAbortRef = useRef(null);

  /**
   * Request camera permission on-demand
   * @returns {Promise<MediaStream | null>} - Returns stream or null if denied/error
   */
  const requestCamera = useCallback(async () => {
    // If already requesting, don't make duplicate requests
    if (permissionState === 'requesting') {
      console.warn('[PERMISSIONS] Camera request already in-flight');
      return null;
    }

    // If already granted, don't request again
    if (permissionState === 'granted') {
      console.log('[PERMISSIONS] Camera already granted, requesting stream again');
    }

    setPermissionState('requesting');
    setPermissionError('');
    permissionAbortRef.current = new AbortController();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
        audio: false, // Don't request audio yet
      });

      setPermissionState('granted');
      console.log('[PERMISSIONS] Camera access granted');
      return stream;
    } catch (err) {
      const errorName = err?.name || '';
      console.error('[PERMISSIONS] Camera request failed:', errorName, err);

      if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') {
        setPermissionState('denied');
        setPermissionError('Camera permission denied by user. You can still see others and use chat.');
      } else if (errorName === 'NotFoundError') {
        setPermissionState('error');
        setPermissionError('No camera found on this device.');
      } else if (errorName === 'NotReadableError') {
        setPermissionState('error');
        setPermissionError('Camera is in use by another application.');
      } else {
        setPermissionState('error');
        setPermissionError(`Camera error: ${errorName || 'Unknown'}`);
      }

      return null;
    }
  }, [permissionState]);

  /**
   * Request microphone permission on-demand
   * @returns {Promise<MediaStream | null>} - Returns stream or null if denied/error
   */
  const requestMicrophone = useCallback(async () => {
    if (permissionState === 'requesting') {
      console.warn('[PERMISSIONS] Mic request already in-flight');
      return null;
    }

    setPermissionState('requesting');
    setPermissionError('');
    permissionAbortRef.current = new AbortController();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false, // Don't request video yet
      });

      setPermissionState('granted');
      console.log('[PERMISSIONS] Microphone access granted');
      return stream;
    } catch (err) {
      const errorName = err?.name || '';
      console.error('[PERMISSIONS] Mic request failed:', errorName, err);

      if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') {
        setPermissionState('denied');
        setPermissionError('Microphone permission denied by user. Text chat is still available.');
      } else if (errorName === 'NotFoundError') {
        setPermissionState('error');
        setPermissionError('No microphone found on this device.');
      } else if (errorName === 'NotReadableError') {
        setPermissionState('error');
        setPermissionError('Microphone is in use by another application.');
      } else {
        setPermissionState('error');
        setPermissionError(`Microphone error: ${errorName || 'Unknown'}`);
      }

      return null;
    }
  }, [permissionState]);

  /**
   * Request both camera and microphone together
   * @returns {Promise<MediaStream | null>}
   */
  const requestFullMedia = useCallback(async () => {
    if (permissionState === 'requesting') {
      console.warn('[PERMISSIONS] Full media request already in-flight');
      return null;
    }

    setPermissionState('requesting');
    setPermissionError('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      setPermissionState('granted');
      console.log('[PERMISSIONS] Full media access granted');
      return stream;
    } catch (err) {
      const errorName = err?.name || '';
      console.error('[PERMISSIONS] Full media request failed:', errorName, err);

      if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') {
        setPermissionState('denied');
        setPermissionError('Media permission denied. You can still view the meeting.');
      } else {
        setPermissionState('error');
        setPermissionError(`Media error: ${errorName || 'Unknown'}`);
      }

      return null;
    }
  }, [permissionState]);

  /**
   * Reset permission state (e.g., when retrying after denial)
   */
  const resetPermissions = useCallback(() => {
    setPermissionState('idle');
    setPermissionError('');
  }, []);

  /**
   * Cancel in-flight permission requests
   */
  const cancelRequest = useCallback(() => {
    if (permissionAbortRef.current) {
      permissionAbortRef.current.abort();
      permissionAbortRef.current = null;
    }
    setPermissionState('idle');
  }, []);

  return {
    permissionState,
    permissionError,
    requestCamera,
    requestMicrophone,
    requestFullMedia,
    resetPermissions,
    cancelRequest,
  };
}
