import React, { useState, useEffect, useCallback } from 'react';
import { loadForm, saveForm, CharacterFormState } from '../utils/storage';
import { api } from '../api/client';
import { CharacterPresets } from '../api/types';
import { ChipGroup } from '../components/ChipGroup';
import { ModelSelector } from '../components/ModelSelector';
import { ActionPreview } from '../components/ActionPreview';
import { RecentJobsPanel } from '../components/RecentJobsPanel';

const IMAGE_ASPECTS = ['1:1', '9:16', '16:9', '3:4', '4:3'].map((a) => ({ value: a, label: a }));
const COUNTS = [1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }));

export const CharacterCreatePage: React.FC = () => {
  const [form, setForm] = useState<CharacterFormState>(() => loadForm('character'));
  const [presets, setPresets] = useState<CharacterPresets | null>(null);

  useEffect(() => {
    saveForm('character', form);
  }, [form]);

  useEffect(() => {
    let active = true;
    api<CharacterPresets>('/api/presets/character')
      .then((p) => {
        if (active) setPresets(p);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const update = (patch: Partial<CharacterFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const rebuildPrompt = useCallback(
    async (force = false, currentForm = form) => {
      if (currentForm.promptEdited && !force) return;
      try {
        const r = await api<{ prompt: string }>('/api/presets/character/prompt', {
          method: 'POST',
          body: {
            gender: currentForm.gender,
            country: currentForm.country,
            vibe: currentForm.vibe,
            extras: currentForm.extras,
          },
        });
        update({ prompt: r.prompt, promptEdited: !force && currentForm.promptEdited });
      } catch {
        /* ignore */
      }
    },
    [form]
  );

  useEffect(() => {
    if (!form.prompt) {
      rebuildPrompt(true);
    }
  }, []);

  const getSpec = () => {
    return {
      type: 'character',
      prompt: form.prompt,
      ...(form.useCustom ? { model: (form.customModel || '').trim() } : { family: form.family }),
      aspect: form.aspect,
      count: form.count,
      character: {
        gender: form.gender,
        country: form.country,
        vibe: form.vibe,
        extras: form.extras,
      },
    };
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Nhân vật</h1>
          <p>
            Chân dung chính diện dùng làm tham chiếu cho các cảnh sau (vẫn là ogiZ0b). Ảnh tạo ra có
            nhãn "character" trong Thư viện.
          </p>
        </div>
      </div>

      <div className="cols">
        <div className="card">
          {!presets ? (
            <p className="empty">Đang tải preset…</p>
          ) : (
            <div>
              <div className="field">
                <div className="field-label">Giới tính</div>
                <ChipGroup
                  toggle={true}
                  options={presets.genders.map((g) => ({ value: g.key, label: g.label }))}
                  value={form.gender}
                  onChange={(gender) => {
                    const next = { ...form, gender };
                    update({ gender });
                    rebuildPrompt(false, next);
                  }}
                />
              </div>

              <div className="field">
                <div className="field-label">Quốc gia</div>
                <ChipGroup
                  toggle={true}
                  options={presets.countries.map((c) => ({ value: c.key, label: c.label }))}
                  value={form.country}
                  onChange={(country) => {
                    const next = { ...form, country };
                    update({ country });
                    rebuildPrompt(false, next);
                  }}
                />
              </div>

              <div className="field">
                <div className="field-label">Phong cách</div>
                <ChipGroup
                  options={presets.vibes.map((v) => ({ value: v.key, label: v.label }))}
                  value={form.vibe}
                  onChange={(vibe) => {
                    const next = { ...form, vibe };
                    update({ vibe });
                    rebuildPrompt(false, next);
                  }}
                />
              </div>
            </div>
          )}

          <div className="field">
            <div className="field-label">Mô tả thêm (tuỳ chọn)</div>
            <input
              className="input"
              value={form.extras}
              placeholder="VD: tóc ngắn màu nâu, 25 tuổi"
              onChange={(e) => {
                const extras = e.target.value;
                const next = { ...form, extras };
                update({ extras });
                rebuildPrompt(false, next);
              }}
            />
          </div>

          <div className="field">
            <div className="field-label">
              <span>Prompt sẽ gửi </span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => rebuildPrompt(true, { ...form, promptEdited: false })}
              >
                ↺ tạo lại từ lựa chọn
              </button>
            </div>
            <textarea
              className="input"
              rows={7}
              value={form.prompt}
              onChange={(e) => update({ prompt: e.target.value, promptEdited: true })}
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

          <div className="field">
            <div className="field-label">Số ảnh</div>
            <ChipGroup
              options={COUNTS}
              value={form.count}
              onChange={(count) => update({ count })}
            />
          </div>

          <ActionPreview label="Tạo nhân vật" getSpec={getSpec} />
        </div>

        <RecentJobsPanel types={['character']} />
      </div>
    </div>
  );
};

