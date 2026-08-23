import { useState, useEffect } from 'react';

export function useVerifiedSession() {
  const [enabled, setEnabled] = useState(() => {
    return localStorage.getItem('verifiedMode') === 'true';
  });
  
  const [batchId, setBatchId] = useState(() => {
    return localStorage.getItem('verifiedBatchId') || crypto.randomUUID();
  });
  
  const [knownTerms, setKnownTerms] = useState(() => {
    return localStorage.getItem('verifiedKnownTerms') || '';
  });

  useEffect(() => {
    localStorage.setItem('verifiedMode', String(enabled));
  }, [enabled]);

  useEffect(() => {
    localStorage.setItem('verifiedBatchId', batchId);
  }, [batchId]);

  useEffect(() => {
    localStorage.setItem('verifiedKnownTerms', knownTerms);
  }, [knownTerms]);

  const startNewSession = () => {
    setBatchId(crypto.randomUUID());
  };

  return {
    enabled,
    setEnabled,
    batchId,
    knownTerms,
    setKnownTerms,
    startNewSession
  };
}