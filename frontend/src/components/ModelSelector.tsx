import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../api/client';
import { ModelFamily, ModelVariant, ResolveModelResponse } from '../api/types';
import { getVideoCreditCost } from '../utils/format';

interface ModelSelectorProps {
  mode: string;
  family: string | null;
  useCustom: boolean;
  customModel: string;
  aspect?: string;
  duration?: number | null;
  resolution?: string | null;
  onFamilyChange: (family: string | null) => void;
  onUseCustomChange: (useCustom: boolean) => void;
  onCustomModelChange: (customModel: string) => void;
  onVariantsLoaded?: (variants: ModelVariant[]) => void;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  mode,
  family,
  useCustom,
  customModel,
  aspect,
  duration,
  resolution,
  onFamilyChange,
  onUseCustomChange,
  onCustomModelChange,
  onVariantsLoaded,
}) => {
  const [families, setFamilies] = useState<ModelFamily[]>([]);
  const [resolvedKey, setResolvedKey] = useState<string>('');
  const [resolveStatus, setResolveStatus] = useState<string>('');
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Load families for mode
  useEffect(() => {
    let active = true;
    api<{ families: ModelFamily[] }>(`/api/models?mode=${mode}`)
      .then((data) => {
        if (!active) return;
        const valid = (data.families || []).filter((f) =>
          f.variants.some((v) => v.status !== 'disabled')
        );
        setFamilies(valid);

        // Auto select default if not set
        if (!useCustom && !family && valid.length > 0) {
          const defaultFam = valid.find((f) => f.default) || valid[0];
          onFamilyChange(defaultFam.family);
        }
      })
      .catch(() => {
        if (active) setFamilies([]);
      });

    return () => {
      active = false;
    };
  }, [mode]);

  // Pass variants to parent when family changes
  const currentVariants = useMemo(() => {
    const found = families.find((f) => f.family === family);
    return found ? found.variants : [];
  }, [families, family]);

  useEffect(() => {
    if (onVariantsLoaded) {
      onVariantsLoaded(currentVariants);
    }
  }, [currentVariants, onVariantsLoaded]);

  // Resolve wire id
  const resolve = useCallback(async () => {
    if (useCustom) {
      setResolvedKey(customModel || '?');
      setResolveStatus('');
      setResolveError(null);
      return;
    }

    if (!family) {
      setResolvedKey('');
      setResolveStatus('');
      return;
    }

    const q = new URLSearchParams({ mode, family });
    if (aspect) q.set('aspect', aspect);
    if (duration !== null && duration !== undefined) q.set('duration', String(duration));
    if (resolution) q.set('resolution', resolution);

    try {
      const res = await api<ResolveModelResponse>(`/api/models/resolve?${q}`);
      setResolvedKey(res.key);
      setResolveStatus(res.status);
      setResolveError(null);
    } catch (e: any) {
      setResolveError(e.message);
    }
  }, [mode, family, useCustom, customModel, aspect, duration, resolution]);

  useEffect(() => {
    const timer = setTimeout(resolve, 150);
    return () => clearTimeout(timer);
  }, [resolve]);

  const isVideoMode = ['t2v', 'i2v', 'first_last', 'r2v'].includes(mode);

  const getLineText = () => {
    if (resolveError) return resolveError;
    if (useCustom) {
      let t = `→ ${customModel || '?'} (wire id tự nhập)`;
      if (isVideoMode) {
        t += ` • 💳 Tín dụng: ${getVideoCreditCost(customModel, duration || undefined, resolution || undefined)}`;
      }
      return t;
    }
    let t = `→ ${resolvedKey || '…'}`;
    if (isVideoMode && resolvedKey) {
      t += ` • 💳 Tín dụng: ${getVideoCreditCost(resolvedKey, duration || undefined, resolution || undefined)}`;
    }
    return t;
  };

  const getLineClass = () => {
    if (resolveError) return 'model-line err';
    if (useCustom) return 'model-line';
    if (resolveStatus === 'verified') return 'model-line';
    return 'model-line warn';
  };

  return (
    <div>
      <select
        className="input"
        value={useCustom ? '__custom' : family || ''}
        onChange={(e) => {
          if (e.target.value === '__custom') {
            onUseCustomChange(true);
          } else {
            onUseCustomChange(false);
            onFamilyChange(e.target.value);
          }
        }}
      >
        {families.map((f) => {
          const verified = f.variants.some((v) => v.status === 'verified');
          return (
            <option key={f.family} value={f.family}>
              {`${f.label}${f.default ? ' (mặc định)' : ''}${verified ? '' : ' · chưa xác minh'}`}
            </option>
          );
        })}
        <option value="__custom">Wire id khác…</option>
      </select>

      {useCustom && (
        <input
          className="input mono"
          placeholder="wire id, VD: veo_3_1_t2v_fast"
          spellCheck={false}
          value={customModel}
          onChange={(e) => onCustomModelChange(e.target.value)}
          style={{ marginTop: '6px' }}
        />
      )}

      <div className={getLineClass()}>{getLineText()}</div>
    </div>
  );
};

