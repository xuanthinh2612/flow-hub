import { CHARACTER_GENDERS, CHARACTER_COUNTRIES, CHARACTER_VIBES, type GenderKey, type CountryKey, type VibeKey } from "../../../constants/character";
import { InfoTip } from "./InfoTip";

interface CharacterBuilderProps {
  isCharacter: boolean;
  charGender: GenderKey | null;
  setCharGender: (value: GenderKey | null) => void;
  charCountry: CountryKey | null;
  setCharCountry: (value: CountryKey | null) => void;
  charVibe: VibeKey;
  setCharVibe: (value: VibeKey) => void;
  charExtras: string;
  setCharExtras: (value: string) => void;
  isWorking: boolean;
}

export function CharacterBuilder({
  isCharacter,
  charGender,
  setCharGender,
  charCountry,
  setCharCountry,
  charVibe,
  setCharVibe,
  charExtras,
  setCharExtras,
  isWorking,
}: CharacterBuilderProps) {
  return (
    <>
      {/* Character builder (character node only) */}
        {isCharacter && (
          <>
            <div className="gen-dialog__field">
              <span className="gen-dialog__label">Gender</span>
              <div className="aspect-chip-row">
                {CHARACTER_GENDERS.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    disabled={isWorking}
                    className={`aspect-chip${charGender === g.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharGender(charGender === g.key ? null : g.key)}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <span className="gen-dialog__label">Quốc gia</span>
              <div className="aspect-chip-row">
                {CHARACTER_COUNTRIES.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    disabled={isWorking}
                    className={`aspect-chip${charCountry === c.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharCountry(charCountry === c.key ? null : c.key)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <span className="gen-dialog__label">Vibe</span>
              <div className="aspect-chip-row">
                {CHARACTER_VIBES.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    disabled={isWorking}
                    className={`aspect-chip${charVibe === v.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharVibe(v.key)}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <div className="gen-dialog__label-row">
                <label className="gen-dialog__label" htmlFor="gen-char-extras">
                  Mô tả thêm (tuỳ chọn)
                  <InfoTip tip="Prompt được auto-build: portrait headshot · vibe styling · photorealistic — tối ưu cho character reference." />
                </label>
                <span className="gen-dialog__char-count">{charExtras.length}/200</span>
              </div>
              {/* FIX(bug 5): Leave the initial focus target on the main prompt only. */}
              <textarea
                id="gen-char-extras"
                className="gen-dialog__textarea"
                rows={3}
                value={charExtras}
                disabled={isWorking}
                onChange={(e) => setCharExtras(e.target.value)}
                placeholder="Tuổi, kiểu tóc, trang phục, biểu cảm…"
              />
            </div>
          </>
        )}
    </>
  );
}
