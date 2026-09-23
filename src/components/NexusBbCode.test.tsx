import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NexusBbCode, NexusDescription } from "./NexusBbCode";

describe("NexusBbCode", () => {
  it("renders common Nexus formatting and nested lists", () => {
    const { container } = render(
      <NexusBbCode>
        {"[h1]Features[/h1][list][*][b]Fast[/b][*][i]Safe[/i][/list]"}
      </NexusBbCode>,
    );

    expect(screen.getByRole("heading", { name: "Features" })).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("Fast");
    expect(container.querySelector("em")?.textContent).toBe("Safe");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("allows safe links while dropping unsafe destinations", () => {
    render(
      <NexusBbCode>
        {"[url=https://example.com/docs]Docs[/url] [url=javascript:alert(1)]Unsafe[/url]"}
      </NexusBbCode>,
    );

    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "https://example.com/docs",
    );
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
    expect(screen.getByText("Unsafe")).toBeTruthy();
  });

  it("keeps unknown tags and raw html inert", () => {
    const { container } = render(
      <NexusBbCode>
        {"[rainbow]Visible[/rainbow] <img src=x onerror=alert(1)>"}
      </NexusBbCode>,
    );

    expect(container.textContent).toContain("[rainbow]Visible[/rainbow]");
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders Nexus html-style break markers as line breaks", () => {
    const { container } = render(
      <NexusBbCode>{"Before<br>Middle<br />After<br/>Done"}</NexusBbCode>,
    );

    expect(container.textContent).toBe("BeforeMiddleAfterDone");
    expect(container.querySelectorAll("br")).toHaveLength(3);
    expect(container.textContent).not.toContain("<br");
  });

  it("renders safe remote images with privacy and layout safeguards", () => {
    const { container } = render(
      <NexusBbCode>{"[img]https://example.com/banner.png[/img]"}</NexusBbCode>,
    );

    const image = screen.getByRole("img", { name: "Nexus mod description" });
    expect(image).toHaveAttribute(
      "src",
      "https://example.com/banner.png",
    );
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("decoding", "async");
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(image.classList.contains("nexus-bbcode__image")).toBe(true);
    expect(container.textContent).not.toContain("View image");
  });

  it("does not load unsafe image destinations", () => {
    const { container } = render(
      <NexusBbCode>{"[img]javascript:alert(1)[/img]"}</NexusBbCode>,
    );

    expect(container.querySelector("img")).toBeNull();
  });

  it("collapses long descriptions until the user expands them", () => {
    render(
      <NexusDescription>{"A detailed Nexus description. ".repeat(20)}</NexusDescription>,
    );

    const toggle = screen.getByRole("button", { name: "Show full description" });
    const contentId = toggle.getAttribute("aria-controls");
    const content = contentId ? document.getElementById(contentId) : null;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(content?.classList.contains("nexus-description__content--collapsed")).toBe(true);

    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(content?.classList.contains("nexus-description__content--expanded")).toBe(true);
  });
});
