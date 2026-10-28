import type { SceneLabelMode, SceneStyle } from "@trackwall/scene/model";
import { useState } from "react";
import { Surface } from "@/components/Surface";
import { type HomeSceneSettings, readHomeSceneSettings, saveHomeSceneSettings } from "@/lib/home-scene-settings";

const STYLES: ReadonlyArray<{ value: SceneStyle; label: string; hint: string }> = [
  { value: "holo", label: "Holograms", hint: "Each kind of repo has its own shape, with a ring that fills as changes pile up." },
  { value: "orbs", label: "Orbs", hint: "Glowing spheres sized by the changes. Lighter for a slow graphics card." },
];

const LABELS: ReadonlyArray<{ value: SceneLabelMode; label: string; hint: string }> = [
  { value: "all", label: "Every repo", hint: "Every repo is named, and the ones with something going on also show what." },
  {
    value: "needs-you",
    label: "Only what needs you",
    hint: "Repos with changes or commits to pull, and sessions waiting for you, as in the Needs you list.",
  },
];

/** How Home draws its 3D scene on this computer (ADR-104); Home reads it the next time it opens. */
export function HomeSceneSurface() {
  const [settings, setSettings] = useState(() => readHomeSceneSettings(() => window.localStorage));
  const change = (next: HomeSceneSettings) => {
    setSettings(next);
    saveHomeSceneSettings(() => window.localStorage, next);
  };
  return (
    <Surface label="Home scene">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">How the 3D view on Home draws your repos and sessions on this computer.</p>
        <Choice
          name="home-scene-style"
          legend="Style"
          options={STYLES}
          value={settings.style}
          onChange={(style) => change({ ...settings, style })}
        />
        <Choice
          name="home-scene-labels"
          legend="Labels"
          options={LABELS}
          value={settings.labels}
          onChange={(labels) => change({ ...settings, labels })}
        />
      </div>
    </Surface>
  );
}

function Choice<T extends string>(props: {
  name: string;
  legend: string;
  options: ReadonlyArray<{ value: T; label: string; hint: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="hud-label mb-1">{props.legend}</legend>
      {props.options.map((option) => (
        <label key={option.value} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={props.name}
            value={option.value}
            checked={props.value === option.value}
            onChange={() => props.onChange(option.value)}
            className="accent-primary mt-0.5 size-4 shrink-0"
          />
          <span className="flex flex-col">
            <span>{option.label}</span>
            <span className="text-muted-foreground">{option.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
