// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerCombo } from "../src/components/composer-combo";

const options = [
  { value: "grok-4.5", label: "Grok 4.5", description: "Modelo principal" },
  { value: "grok-4.1", label: "Grok 4.1", description: "Modelo econômico" },
];

afterEach(cleanup);

describe("ComposerCombo", () => {
  it("renders the selected value closed", () => {
    render(
      <ComposerCombo
        label="Modelo"
        value="grok-4.5"
        options={options}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /modelo: grok 4\.5/i })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens the menu and selects an option", () => {
    const onChange = vi.fn();
    render(
      <ComposerCombo
        label="Modelo"
        value="grok-4.5"
        options={options}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /modelo: grok 4\.5/i }));

    expect(screen.getByRole("listbox", { name: "Modelo" })).toBeInTheDocument();
    expect(screen.getByText("Modelo econômico")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /grok 4\.1/i }));

    expect(onChange).toHaveBeenCalledWith("grok-4.1");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("supports keyboard navigation and escape", () => {
    const onChange = vi.fn();
    render(
      <ComposerCombo
        label="Nível"
        value="grok-4.5"
        options={options}
        onChange={onChange}
      />
    );

    const trigger = screen.getByRole("button", { name: /nível: grok 4\.5/i });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const list = screen.getByRole("listbox", { name: "Nível" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("grok-4.1");

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("does not open when disabled", () => {
    render(
      <ComposerCombo
        label="Modelo"
        value="grok-4.5"
        options={options}
        disabled
        onChange={vi.fn()}
      />
    );

    const trigger = screen.getByRole("button", { name: /modelo: grok 4\.5/i });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
