import React, { useState, useEffect, useMemo } from 'react';
import { loadForm, saveForm, VideoFormState } from '../utils/storage';
import { ModelVariant } from '../api/types';
import { ChipGroup } from '../components/ChipGroup';
import { MediaPicker } from '../components/MediaPicker';
import { ModelSelector } from '../components/ModelSelector';
import { ActionPreview } from '../components/ActionPreview';
import { RecentJobsPanel } from '../components/RecentJobsPanel';

const VIDEO_MODES = [
  { value: 't2v' as const, label: 'Text → Video', hint: 'YhhmEf' },
  { value: 'i2v' as const, label: 'Ảnh → Video', hint: 'eb1hJf' },
  { value: 'first_last' as const, label: 'Ảnh đầu + cuối', hint: 'nprQif' },
  { value: 'r2v' as const, label: 'Ingredients', hint: 'MZZa6b' },
];

const VIDEO_ASPECTS = [
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
];

const COUNTS = [1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }));

export const VideoCreatePage: React.FC = () => {
  const [form, setForm] = useState<VideoFormState>(() => loadForm('video'));
  const [variants, setVariants] = useState<ModelVariant[]>([]);

  useEffect(() => {
    saveForm('video', form);
  }, [form]);

  const update = (patch: Partial<VideoFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const currentFamily = form.families?.[form.mode] || null;

  // Derive available durations and resolutions from current model variants
  const availableDurations = useMemo(() => {
    return Array.from(new Set(variants.map((v) => v.duration).filter(Boolean) as number[])).sort(
      (a, b) => a - b
    );
  }, [variants]);

  const availableResolutions = useMemo(() => {
    return Array.from(new Set(variants.map((v) => v.resolution).filter(Boolean) as string[]));
  }, [variants]);

  useEffect(() => {
    if (availableDurations.length && !availableDurations.includes(form.duration)) {
      update({ duration: availableDurations.includes(8) ? 8 : availableDurations[0] });
    }
  }, [availableDurations, form.duration]);

  useEffect(() => {
    if (availableResolutions.length && !availableResolutions.includes(form.resolution)) {
      update({ resolution: availableResolutions[0] });
    }
  }, [availableResolutions, form.resolution]);

  const getSpec = () => {
    const hasDur = variants.some((v) => v.duration);
    const hasRes = variants.some((v) => v.resolution);
    return {
      type: form.mode,
      prompt: form.prompt,
      ...(form.useCustom
        ? { model: (form.customModel || '').trim() }
        : { family: form.families?.[form.mode] || null }),
      aspect: form.aspect,
      count: form.count,
      duration: hasDur ? form.duration : null,
      resolution: hasRes ? form.resolution : null,
      start_media_ids: form.mode === 'i2v' ? form.starts : [],
      start_media_id: form.mode === 'first_last' ? form.start : null,
      end_media_id: form.mode === 'first_last' ? form.end : null,
      ref_media_ids: form.mode === 'r2v' ? form.refs : [],
      timeout_min: Number(form.timeoutMin) || 10,
    };
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Tạo video</h1>
          <p>
            Gửi lệnh, server tự poll (jwpduf → as29s như giao diện Flow) và lưu video về Thư viện.
          </p>
        </div>
      </div>

      <div className="cols">
        <div className="card">
          <ChipGroup
            cls="seg"
            options={VIDEO_MODES}
            value={form.mode}
            onChange={(mode) => update({ mode })}
          />

          {form.mode === 'i2v' && (
            <div className="field">
              <div className="field-label">Ảnh đầu (mỗi ảnh → 1 video)</div>
              <MediaPicker
                value={form.starts}
                multi={true}
                onChange={(starts) => update({ starts })}
                kind="image"
              />
            </div>
          )}

          {form.mode === 'first_last' && (
            <div className="grid-2">
              <div className="field">
                <div className="field-label">Ảnh đầu</div>
                <MediaPicker
                  value={form.start}
                  multi={false}
                  onChange={(start) => update({ start })}
                  kind="image"
                />
              </div>
              <div className="field">
                <div className="field-label">Ảnh cuối</div>
                <MediaPicker
                  value={form.end}
                  multi={false}
                  onChange={(end) => update({ end })}
                  kind="image"
                />
              </div>
            </div>
          )}

          {form.mode === 'r2v' && (
            <div className="field">
              <div className="field-label">Ingredients (nhân vật, đồ vật, bối cảnh…)</div>
              <MediaPicker
                value={form.refs}
                multi={true}
                onChange={(refs) => update({ refs })}
                kind="image"
              />
            </div>
          )}

          <div className="field">
            <div className="field-label">Prompt</div>
            <textarea
              className="input"
              rows={4}
              value={form.prompt}
              placeholder="Mô tả chuyển động, camera, âm thanh…"
              onChange={(e) => update({ prompt: e.target.value })}
            />
          </div>

          <div className="field">
            <div className="field-label">Model</div>
            <ModelSelector
              mode={form.mode}
              family={currentFamily}
              useCustom={form.useCustom}
              customModel={form.customModel}
              aspect={form.aspect}
              duration={availableDurations.length ? form.duration : null}
              resolution={availableResolutions.length ? form.resolution : null}
              onFamilyChange={(fam) =>
                update({
                  families: { ...(form.families || {}), [form.mode]: fam },
                })
              }
              onUseCustomChange={(useCustom) => update({ useCustom })}
              onCustomModelChange={(customModel) => update({ customModel })}
              onVariantsLoaded={(vars) => setVariants(vars)}
            />
          </div>

          {availableDurations.length > 0 && (
            <div className="field">
              <div className="field-label">Thời lượng</div>
              <ChipGroup
                options={availableDurations.map((d) => ({ value: d, label: `${d}s` }))}
                value={form.duration}
                onChange={(duration) => update({ duration })}
              />
            </div>
          )}

          {availableResolutions.length > 0 && (
            <div className="field">
              <div className="field-label">Độ phân giải</div>
              <ChipGroup
                options={availableResolutions.map((r) => ({ value: r, label: r }))}
                value={form.resolution}
                onChange={(resolution) => update({ resolution })}
              />
            </div>
          )}

          <div className="grid-2">
            <div className="field">
              <div className="field-label">Tỉ lệ</div>
              <ChipGroup
                options={VIDEO_ASPECTS}
                value={form.aspect}
                onChange={(aspect) => update({ aspect })}
              />
            </div>
            <div className="field">
              <div className="field-label">
                {form.mode === 'i2v' ? 'Số video mỗi ảnh' : 'Số video'}
              </div>
              <ChipGroup
                options={COUNTS}
                value={form.count}
                onChange={(count) => update({ count })}
              />
            </div>
          </div>

          <details className="adv">
            <summary>Nâng cao</summary>
            <div className="field">
              <div className="field-label">Thời gian chờ tối đa (phút)</div>
              <input
                className="input"
                type="number"
                min={1}
                max={60}
                value={form.timeoutMin}
                onChange={(e) => update({ timeoutMin: Number(e.target.value) })}
              />
            </div>
          </details>

          <ActionPreview label="Tạo video" getSpec={getSpec} />
        </div>

        <RecentJobsPanel types={['t2v', 'i2v', 'first_last', 'r2v']} />
      </div>
    </div>
  );
};

