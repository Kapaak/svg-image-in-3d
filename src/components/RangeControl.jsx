export default function RangeControl({ id, label, title, value, unit = '', min, max, step = 1, disabled = false, onChange }) {
  return (
    <div className={`control${disabled ? ' disabled' : ''}`} title={title}>
      <div className="control-row">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{value}{unit}</output>
      </div>
      <input
        type="range"
        id={id}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}
