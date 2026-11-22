/** One choice of a Settings section as radio buttons, each option with a line on what it does. */
export function Choice<T extends string>(props: {
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
