import { Surface } from "@/components/Surface";
import { THEME_CHOICE_LABELS, type ThemeChoice } from "@/lib/theme";
import { useTheme } from "@/lib/theme-controller";

const CHOICES: ReadonlyArray<{ value: ThemeChoice; hint: string }> = [
  { value: "dark", hint: "The HUD on a black background." },
  { value: "light", hint: "The same on a light background. Terminals and the Home scene stay dark." },
  { value: "system", hint: "Dark or light as Windows or macOS is, changing when it changes." },
];

/** The app's theme on this computer (ADR-235); every open window takes a change at once. */
export function ThemeSurface() {
  const { choice, choose } = useTheme();
  return (
    <Surface label="Theme">
      <fieldset className="flex flex-col gap-2 p-4">
        <legend className="sr-only">Theme</legend>
        {CHOICES.map((option) => (
          <label key={option.value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="theme"
              value={option.value}
              checked={choice === option.value}
              onChange={() => choose(option.value)}
              className="accent-primary mt-0.5 size-4 shrink-0"
            />
            <span className="flex flex-col">
              <span>{THEME_CHOICE_LABELS[option.value]}</span>
              <span className="text-muted-foreground">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </Surface>
  );
}
