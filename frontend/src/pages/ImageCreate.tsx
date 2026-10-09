import React, { useState, useEffect } from 'react';
import { loadForm, saveForm, ImageFormState } from '../utils/storage';
import { ChipGroup } from '../components/ChipGroup';
import { MediaPicker } from '../components/MediaPicker';
import { ModelSelector } from '../components/ModelSelector';
import { ActionPreview } from '../components/ActionPreview';
import { RecentJobsPanel } from '../components/RecentJobsPanel';

const IMAGE_ASPECTS = ['1:1', '9:16', '16:9', '3:4', '4:3'].map((a) => ({ value: a, label: a }));
const COUNTS = [1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }));
const lines = (text: string) => (text || '').split('\n').map((s) => s.trim()).filter(Boolean);

export const ImageCreatePage: React.FC = () => {
  const [form, setForm] = useState<ImageFormState>(() => loadForm('image'));

  useEffect(() => {
    saveForm('image', form);
  }, [form]);

  const update = (patch: Partial<ImageFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const getSpec = () => {
    return {
      type: form.mode === 'edit' ? 'edit' : 'image',
      prompt: form.prompt,
      ...(form.useCustom ? { model: (form.customModel || '').trim() } : { family: form.family }),
      aspect: form.aspect,
      count: form.count,
      seed: form.seed === '' || form.seed === null ? null : Number(form.seed),
      prompts: form.mode === 'edit' ? null : lines(form.perVariant).length ? lines(form.perVariant) : null,
      ref_media_ids: form.refs,
      base_media_id: form.mode === 'edit' ? form.base : null,
      character_id: (form.characterId || '').trim() || null,
    };
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Tạo ảnh</h1>
          <p>
            ogiZ0b — tạo mới hoặc sửa ảnh, có ảnh tham chiếu. Các biến thể đi chung một request, như
            giao diện Flow.
          </p>
        </div>
      </div>

      <div className="cols">
        <div className="card">
          <ChipGroup
            cls="seg"
            options={[
              { value: 'gen' as const, label: 'Tạo ảnh' },
              { value: 'edit' as const, label: 'Chỉnh sửa ảnh' },
            ]}
            value={form.mode}
            onChange={(mode) => update({ mode })}
          />

          {form.mode === 'edit' && (
            <div className="field">
              <div className="field-label">
                Ảnh gốc cần sửa <span className="tag">BASE_IMAGE · type 2</span>
              </div>
              <MediaPicker
                value={form.base}
                multi={false}
                onChange={(base) => update({ base })}
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
              placeholder="Mô tả bức ảnh…"
              onChange={(e) => update({ prompt: e.target.value })}
            />
          </div>

          <div className="field">
            <div className="field-label">
              Ảnh tham chiếu <span className="tag">REFERENCE · type 1</span>
              <span className="muted"> (tuỳ chọn)</span>
            </div>
            <MediaPicker
              value={form.refs}
              multi={true}
              onChange={(refs) => update({ refs })}
              kind="image"
            />
          </div>

          <div className="field">
            <div className="field-label">Model</div>
            <ModelSelector
              mode="image"
              family={form.family}
              useCustom={form.useCustom}
              customModel={form.customModel}
              aspect={form.aspect}
              onFamilyChange={(family) => update({ family })}
              onUseCustomChange={(useCustom) => update({ useCustom })}
              onCustomModelChange={(customModel) => update({ customModel })}
            />
          </div>

          <div className="field">
            <div className="field-label">Tỉ lệ</div>
            <ChipGroup
              options={IMAGE_ASPECTS}
              value={form.aspect}
              onChange={(aspect) => update({ aspect })}
            />
          </div>

          {form.mode !== 'edit' && (
            <div className="field">
              <div className="field-label">
                Số ảnh (tất cả trong 1 request + 1 captcha)
              </div>
              <ChipGroup
                options={COUNTS}
                value={form.count}
                onChange={(count) => update({ count })}
              />
            </div>
          )}

          <details className="adv">
            <summary>Nâng cao</summary>
            <div className="field">
              <div className="field-label">Seed (trống = ngẫu nhiên; mỗi biến thể +9973)</div>
              <input
                className="input mono"
                type="number"
                value={form.seed}
                onChange={(e) => update({ seed: e.target.value })}
              />
            </div>

            {form.mode !== 'edit' && (
              <div className="field">
                <div className="field-label">Prompt riêng từng biến thể (mỗi dòng 1 prompt)</div>
                <textarea
                  className="input"
                  rows={3}
                  value={form.perVariant}
                  onChange={(e) => update({ perVariant: e.target.value })}
                />
              </div>
            )}

            <div className="field">
              <div className="field-label">
                Character ID (gắn ảnh vào một Nhân vật đã tạo trên Flow — id trong URL …/character/&lt;id&gt;)
              </div>
              <input
                className="input mono"
                value={form.characterId || ''}
                placeholder="bd55770a-…"
                onChange={(e) => update({ characterId: e.target.value })}
              />
            </div>
          </details>

          <ActionPreview label="Tạo ảnh" getSpec={getSpec} />
        </div>

        <RecentJobsPanel types={['image', 'edit']} />
      </div>
    </div>
  );
};

