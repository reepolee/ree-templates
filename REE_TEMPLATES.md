# Render Module — `$lib/render.ts`

A lightweight rendering layer that wraps a template engine, injects shared context, and returns typed `Response` objects. Works alongside `$lib/template.ts` which configures the underlying engine.

---

## Setup

Before calling any render functions, initialize the module once at app startup — typically in your server entry point.

```ts
import { initialize_render } from "$lib/render";
import { create_template_engine } from "$lib/template";

const engine = create_template_engine(is_dev);

initialize_render(engine, {
	is_dev,
	app_name: "My App",
	// ...any other global template variables
});
```

`base_data` is merged into every template render automatically, so values like `is_dev`, `app_name`, etc. are always available in your templates without passing them manually.

---

## API

### `initialize_render(engine, base_data)`

Initializes the module. Must be called before `render()` or `get_render()`.

| Parameter   | Type                  | Description                                 |
| ----------- | --------------------- | ------------------------------------------- |
| `engine`    | `Engine`              | A template engine with a `.render()` method |
| `base_data` | `Record<string, any>` | Global data merged into every template      |

The `Engine` type requires:

```ts
type Engine = {
	render: (name: string, data?: Record<string, any>) => Promise<string>;
	clearCache?: () => void;
};
```

---

### `render(template, options?)`

Renders a template and returns an HTML `Response`.

```ts
export type RenderOptions = {
	data?: Record<string, any>;
	helpers?: Record<string, any>;
	status?: number;
	headers?: Record<string, string>;
	req?: BunRequest;
};

export async function render(template: string, options?: RenderOptions): Promise<Response>;
```

| Option    | Type                     | Default | Description                                         |
| --------- | ------------------------ | ------- | --------------------------------------------------- |
| `data`    | `Record<string, any>`    | `{}`    | Template-specific data variables                    |
| `helpers` | `Record<string, any>`    | `{}`    | Custom helper functions                             |
| `status`  | `number`                 | `200`   | HTTP status code                                    |
| `headers` | `Record<string, string>` | `{}`    | Additional response headers                         |
| `req`     | `Request`                | —       | Incoming request (enables URL and language context) |

**Returns:** `Promise<Response>` with `Content-Type: text/html`.

#### Automatic context injected into every render

When `req` is provided, the following variables are automatically available in the template:

| Variable      | Source                                     | Description                           |
| ------------- | ------------------------------------------ | ------------------------------------- |
| `request_url` | `req.url` (pathname + search only)         | Relative URL, e.g. `/products?page=2` |
| `lang`        | `X-Lang` header → `lang` cookie → `"en"`   | Active language code                  |
| `locale`      | Derived from `lang` via `language_locales` | Locale string, e.g. `"sl-SI"`         |
| `user`        | Session cookie → session store             | Logged-in user object or `null`       |
| `toasts`      | Cookies with `toast-` prefix               | Array of pending toast notifications  |
| `rendered_at` | `new Date().toLocaleString()`              | Render timestamp string               |

In development mode (`is_dev: true`), two additional debug variables are injected:

| Variable       | Description                                       |
| -------------- | ------------------------------------------------- |
| `toJSON`       | Compact JSON string of the template `data`        |
| `toPrettyJSON` | Pretty-printed JSON string of the template `data` |

---

## Template Helpers

Template helpers are functions available directly in your templates without needing to access them through an object prefix. They handle common formatting, display logic, and custom transformations.

### Default Helpers

Every template automatically has access to these built-in helpers:

#### `yes_no(value, type?)`

Displays a boolean/numeric value as a styled "Yes" or "No".

```ts
yes_no(val: number, type?: "red_green" | "blank_green"): string
```

**Parameters:**

- `val` - Number or boolean (0/false = "No", non-zero/true = "Yes")
- `type` - Style variant:
    - `"blank_green"` (default) - Shows "Yes" with green background, nothing for "No"
    - `"red_green"` - Shows "Yes" in green, "No" in red

**Template example:**

```ree
<div class="status">
  {~ yes_no(record.is_active) }
</div>

<div class="verified">
  {~ yes_no(record.email_verified, "red_green") }
</div>
```

#### `locale_date(date_string, locale?)`

Formats a date string according to locale.

```ts
locale_date(dateString: string, locale?: string): string
```

**Parameters:**

- `date_string` - ISO date string (e.g., `"2024-01-15T10:30:00Z"`)
- `locale` - Language code (default: `data.locale`, resolved from the active language)

**Template example:**

```ree
<p>Created: {= locale_date(record.created_at) }</p>
<p>Joined: {= locale_date(record.joined_date, "en-US") }</p>
```

#### `locale_time(date_string, locale?)`

Formats a date string's time portion according to locale.

```ts
locale_time(dateString: string, locale?: string): string
```

**Parameters:**

- `date_string` - ISO date string
- `locale` - Language code (default: `data.locale`)

**Template example:**

```ree
<p>Opens at: {= locale_time(record.opens_at) }</p>
```

#### `locale_ts(date_string, locale?)`

Formats a date string as full date+time according to locale.

```ts
locale_ts(dateString: string, locale?: string): string
```

**Parameters:**

- `date_string` - ISO date string
- `locale` - Language code (default: `data.locale`)

**Template example:**

```ree
<p>Last updated: {= locale_ts(record.updated_at) }</p>
```

#### `display_currency(val, locale?, hide_zero?, symbol?)`

Formats a number as currency.

```ts
display_currency(val: number, locale?: string, hide_zero?: boolean, symbol?: string): string
```

**Parameters:**

- `val` - Numeric value
- `locale` - Locale for formatting (default: `data.locale`)
- `hide_zero` - If `true`, returns empty string for zero values (default: `false`)
- `symbol` - Currency symbol (default: `"€"`)

**Template example:**

```ree
<p>{~ display_currency(record.price) }</p>
<p>{~ display_currency(record.tax, "en-US", false, "$") }</p>
```

#### `display_percent(val, locale?)`

Formats a number as percentage.

```ts
display_percent(val: number, locale?: string): string
```

**Parameters:**

- `val` - Numeric value (e.g. `0.15` → `"15%"`)
- `locale` - Locale for formatting (default: `data.locale`)

**Template example:**

```ree
<p>Discount: {= display_percent(record.discount_rate) }</p>
```

#### `iso_date(date_string)`

Converts a date to ISO format string.

```ts
iso_date(dateString: string): string
```

**Template example:**

```ree
<time datetime="{= iso_date(record.published_at) }">
  {= locale_date(record.published_at) }
</time>
```

#### `url(path)`

Ensures a path starts with `/` (useful for href attributes).

```ts
url(path: string): string
```

**Template example:**

```ree
<a href="{= url('dashboard') }">Dashboard</a>
<a href="{= url('/profile') }">Profile</a>
```

#### `localized_path(canonical_path)`

Converts a canonical URL path to the current language's localized version using the pre-built route maps. All internal links, form actions, and redirects should use this helper so they work in every language.

```ts
localized_path(canonicalPath: string): string
```

When the current language is Slovenian (`sl`), `/auth/login` becomes `/avtentikacija/prijava`. If no localization exists, the canonical path is returned unchanged.

**Template example:**

```ree
<a href="{~ localized_path('/auth/login') }">Login</a>
<a href="{~ localized_path('/auth/profile') }">Profile</a>
<form method="POST" action="{~ localized_path(data.action) }">
```

See `localized-routes.md` for the full documentation on URL localization.

#### `is_current(page_url)`

Returns CSS classes to highlight current page in navigation.

```ts
is_current(pageUrl: string): string
```

Returns `"font-bold nav-item current"` if the current page matches, otherwise `"nav-item"`.

**Template example:**

```ree
<nav>
  <a href="/home" class="{= is_current('/home') }">Home</a>
  <a href="/about" class="{= is_current('/about') }">About</a>
</nav>
```

### Custom Ad-hoc Helpers

You can pass any custom helper function when rendering. Helpers are defined in the `helpers` object within the data parameter.

#### Basic Example

**Route handler:**

```typescript
import { render } from "$lib/render";

export async function GET_my_page(req: BunRequest) {
	return render("my-template", {
		data: {
			users: [
				{ id: 1, name: "alice", role: "admin" },
				{ id: 2, name: "bob", role: "user" },
			],
		},
		helpers: {
			uppercase: (text) => text.toUpperCase(),
			badge_color: (role) => (role === "admin" ? "bg-red-500" : "bg-blue-500"),
		},
		req,
	});
}
```

**Template (`my-template.ree`):**

```ree
<table>
  {#each data.users as user }
    <tr>
      <td>{= uppercase(user.name) }</td>
      <td><span class="{= badge_color(user.role) }">{= user.role }</span></td>
    </tr>
  {/each}
</table>
```

**Output:**

```html
<table>
	<tr>
		<td>ALICE</td>
		<td><span class="bg-red-500">admin</span></td>
	</tr>
	<tr>
		<td>BOB</td>
		<td><span class="bg-blue-500">user</span></td>
	</tr>
</table>
```

#### Combining Multiple Helpers

```typescript
return render("dashboard", {
	data: { records: data },
	helpers: {
		format_price: (amount) => `$${(amount / 100).toFixed(2)}`,
		format_date: (date) => new Date(date).toLocaleDateString("en-US"),
		status_badge: (status) => {
			const colors = {
				pending: "yellow",
				active: "green",
				inactive: "gray",
			};
			return `<span class="badge-${colors[status]}">${status}</span>`;
		},
	},
});
```

**Template:**

```ree
{#each data.records as record }
  <div class="card">
    <h3>{= record.title }</h3>
    <p>Price: {~ format_price(record.amount) }</p>
    <p>Updated: {= format_date(record.updated_at) }</p>
    <div>{~ status_badge(record.status) }</div>
  </div>
{/each}
```

### Helper Scope and Availability

- **Helpers are functions** - They're called with `()` parentheses, not accessed as properties
- **Helpers have access to parameters only** - They cannot access template variables directly
- **Helpers are called during rendering** - Return values are injected into the output
- **Custom helpers override defaults** - If you pass `yes_no` as a custom helper, it replaces the default

#### Incorrect (won't work):

```ree
{~ uppercase() }  <!-- No argument passed -->
{= helpers.uppercase(name) }  <!-- Helpers accessed as object -->
```

#### Correct:

```ree
{~ uppercase(record.name) }
{= uppercase(data.name) }
```

---

### `get_render()`

Returns the raw render function for cases where you need to render a template to a string rather than a `Response` — for example, rendering email bodies or partial fragments.

```ts
const render_template = get_render();
const html = await render_template("emails/welcome", { name: "Alice" });
```

Throws if called before `initialize_render()`.

---

## Language Resolution

`lang` is resolved in priority order:

1. `X-Lang` request header
2. `lang` cookie
3. Falls back to `"en"`

---

## Usage Examples

### Basic route handler

```ts
import { render } from "$lib/render";

export async function GET(req: BunRequest) {
	return render("home/index", { data: { title: "Welcome" }, req });
}
```

### Passing a custom status code

```ts
return render("errors/not-found", {
	data: { message: "Page not found" },
	status: 404,
	req,
});
```

### Adding custom response headers

```ts
return render("dashboard/index", {
	data: { user },
	status: 200,
	headers: {
		"Cache-Control": "no-store",
		"X-Frame-Options": "DENY",
	},
	req,
});
```

### Rendering to a string (e.g. for emails)

```ts
import { get_render } from "$lib/render";

const render_template = get_render();
const emailHtml = await render_template("emails/welcome", { name: "Alice" });
```

### With multiple custom helpers

```typescript
return render("products/list", {
	data: {
		products: await get_products(),
		search_query: new URL(req.url).searchParams.get("q"),
	},
	helpers: {
		price: (cents) => `$${(cents / 100).toFixed(2)}`,
		pub_date: (iso) => new Date(iso).toLocaleDateString(),
		stock_class: (qty) => (qty > 0 ? "in-stock" : "out-of-stock"),
		badge: (text, color = "blue") => `<span class="badge badge-${color}">${text}</span>`,
	},
	status: 200,
	req,
});
```

**Template:**

```ree
{#each data.products as product }
  <div class="product {= stock_class(product.quantity) }">
    <h2>{= product.name }</h2>
    <p>{~ price(product.price_cents) }</p>
    <p>Published: {= pub_date(product.created_at) }</p>
    <p>{~ badge(product.category, "green") }</p>
  </div>
{/each}
```

---

## Common Patterns for Beginners

### Pattern 1: Simple Formatting

Use helpers for one-off transformations of data.

```typescript
helpers: {
  shout: (text) => text.toUpperCase() + "!!!",
}
```

```ree
<p>{~ shout(record.message) }</p>  <!-- Output: "HELLO!!!" -->
```

### Pattern 2: Conditional Display

Use helpers to return different output based on a value.

```typescript
helpers: {
  account_status: (days_active) => {
    if (days_active < 7) return '<span class="new">New</span>';
    if (days_active < 30) return '<span class="active">Active</span>';
    return '<span class="veteran">Veteran</span>';
  },
}
```

```ree
{~ account_status(record.days_active) }
```

### Pattern 3: Chaining Data Transformation

Process data before display using helper logic.

```typescript
helpers: {
  initials: (first_name, last_name) =>
    (first_name[0] + last_name[0]).toUpperCase(),

  avatar_color: (user_id) => {
    const colors = ["red", "blue", "green", "yellow", "purple"];
    return colors[user_id % colors.length];
  },
}
```

```ree
<div class="avatar avatar-{= avatar_color(record.user_id) }">
  {= initials(record.first_name, record.last_name) }
</div>
```

### Pattern 4: Combining Default + Custom Helpers

You can use both default helpers and custom ones together.

```typescript
helpers: {
  status_with_date: (status, date) => {
    const status_html = yes_no(status === "active", "red_green");
    const date_str = locale_date(date);
    return `${status_html} (${date_str})`;
  },
}
```

---

## Template Engine (`$lib/template.ts`)

`create_template_engine` creates and configures the underlying template engine.

```ts
import { create_template_engine } from "$lib/template";

const engine = create_template_engine(is_dev);
```

| Option       | Dev value   | Prod value  |
| ------------ | ----------- | ----------- |
| `views`      | `../routes` | `../routes` |
| `cache`      | `false`     | `true`      |
| `ext`        | `.ree`      | `.ree`      |
| `autoEscape` | `true`      | `true`      |

Templates use the `.ree` extension and are resolved relative to the `routes/` directory.

---

## Template Engine — Full Reference

The engine is a file-based template compiler inspired by Eta.js and Svelte, optimised for the Bun runtime. It compiles `.ree` files to async functions and optionally caches them in production.

### Template Syntax

#### Output tags

| Tag         | Behaviour                      | Example                         |
| ----------- | ------------------------------ | ------------------------------- |
| `{= expr }` | Escaped HTML output            | `{= user.name }`                |
| `{~ expr }` | Unescaped / raw HTML output    | `{~ content.html }`             |
| `{{ ... }}` | Raw JavaScript (double braces) | `{{ const x = items.length; }}` |

HTML escaping converts `& < > " '` to their entity equivalents. Use `{~ }` only when you fully trust the content.

#### Control flow

```
{#if condition }
  ...
{:else}
  ...
{/if}
```

```
{#each list as item }
  ...
{/each}

{#each list as item, index }
  ...
{/each}

{#each list as item, index, key }
  ...
{/each}

{#each list as item }
  ...
{:else}
  (rendered when list is empty)
{/each}
```

`{#each}` works on both arrays and objects. For objects, `item` is the value and `key` is the property name.

#### Layouts and includes

```
{#layout('layouts/base') }
{#layout('layouts/base', { title: 'Home' }) }
```

Declares the layout for the current template. The rendered body of the current template is passed to the layout as `body`. Only one layout per template is supported, and it should be declared at the top.

```
{#include('partials/nav') }
{#include('partials/card', { title, href }) }
```

Includes another template inline. The included template receives a merged copy of the current data plus any extra data object passed as the second argument.

#### Component shorthand

```
{@componentName(props) }
{@card({ title, href }) }
```

Shorthand for `{#include('$components/componentName', props) }`. Components are resolved from the `components/` directory at the project root.

### Path Resolution

Includes and layouts support several path styles:

| Prefix         | Resolves from                    | Example                         |
| -------------- | -------------------------------- | ------------------------------- |
| `$components/` | Project root `components/`       | `$components/button`            |
| `$routes/`     | Project root `routes/`           | `$routes/home/hero`             |
| `$lib/`        | Project root `lib/`              | `$lib/flash`                    |
| `./` or `../`  | Relative to the current template | `./sidebar`, `../shared/footer` |
| `/name`        | Views root (absolute)            | `/layouts/base`                 |
| `name`         | Views root (implicit)            | `layouts/base`                  |

Including a file with a non-`.ree` extension (e.g. `{#include('./styles.css') }`) injects its raw text content unescaped. Including a `.ree` file via an alias path compiles and renders it normally.

**Security:** path traversal outside the resolved base directory throws an error.

### Engine API

```ts
// Render a template file by name (views-root relative, no extension)
const html = await engine.render("home/index", data);

// Render from a template string directly
const html = await engine.renderString("<p>{= greeting }</p>", { greeting: "Hello" });

// Clear the compiled template cache (e.g. after hot-reload)
engine.clearCache();

// Write rendered output to a file (creates directories as needed)
await engine.writeOutput("dist/index.html", html);
```

### Template examples

**Navigation menu**

```ree
<nav>
  {#each data.menuItems as item }
    <a href="{= item.url }" {#if item.active }class="active"{/if}>
      {= item.label }
    </a>
  {/each}
</nav>
```

**Iterating over an object**

```ree
{#each data.settings as value, i, key }
  <div>{= key }: {= value }</div>
{/each}
```

For objects, `item` is the value, `index` is the numeric position, and `key` is the property name.

**Pre-computing values before output**

```ree
{{ const sorted = data.posts.sort((a, b) => b.date - a.date) }}
{{ const recent = sorted.slice(0, 5) }}

{#each recent as post }
  {@post-card({ post })}
{/each}
```

**Form with per-field validation errors**

```ree
<form>
  {#each data.fields as field }
    <div class="field">
      <label>{= field.label }</label>
      <input name="{= field.name }" value="{= field.value || '' }">
      {#if field.error }
        <span class="error">{= field.error }</span>
      {/if}
    </div>
  {/each}
</form>
```

**Nested loops**

```ree
{#each categories as category }
  <section>
    <h2>{= category.name }</h2>
    <ul>
      {#each category.items as item }
        <li>{= item.title }</li>
      {/each}
    </ul>
  </section>
{/each}
```

---

## Troubleshooting

### Template Issues

**Unmatched braces / syntax error** — CSS and JS object literals like `{ color: red }` won't be parsed as tags since the engine only recognises `{=`, `{~`, `{#`, `{:`, `{/`, `{@`, and `{{`. If you see unexpected output, check for a stray tag prefix.

**Template file not found** — the path is resolved relative to the `views` directory (or the alias root for `$components/` etc.). Verify the file exists without the extension, e.g. `engine.render("pages/home")` maps to `<views>/pages/home.ree`.

**Unclosed block error** — every `{#if}` needs `{/if}` and every `{#each}` needs `{/each}`. The error message lists which block types are still open.

**Multiple `{:else}` in same block** — only one `{:else}` is allowed per `{#if}` or `{#each}`.

**Include path escapes base directory** — path traversal outside the resolved root (e.g. `../../../../etc/passwd`) is blocked and throws. Use alias paths (`$lib/`, `$components/`) to reference files outside `views/`.

### Helper Issues

**"Helper is not defined"** — You forgot to pass the helper in the `helpers` object when calling `render()`.

```typescript
// ❌ WRONG - helper not passed
return render("template", { records: data });

// ✅ CORRECT - helper passed
return render("template", {
	records: data,
	helpers: { uppercase: (x) => x.toUpperCase() },
});
```

**"[function] is not a function"** — The helper exists but isn't being called correctly. Helpers must be functions that return a value.

```ree
{~ uppercase(record.name) }  <!-- ✅ Correct -->
{= uppercase(record.name) }  <!-- ✅ Also correct, escapes HTML -->
{~ record.uppercase }        <!-- ❌ Wrong - accessing as property -->
```

**Helper receives wrong type** — Make sure the data you pass matches what the helper expects.

```typescript
// ❌ Helper expects string but receives number
helpers: {
	shout: (text) => text.toUpperCase() + "!!!"; // Will fail if text is a number
}

// ✅ Better - handle multiple types
helpers: {
	shout: (val) => String(val).toUpperCase() + "!!!";
}
```

**Helper can't access template variables** — Helpers only receive what you pass as arguments.

```ree
<!-- ❌ WRONG - helper can't see 'user' variable -->
{~ format_name(user) }

<!-- ✅ CORRECT - pass the value as argument -->
{~ format_name(record.user_name) }
```

**Data not visible in template** — Check that you're passing it in the `data` object, not in `helpers`.

```typescript
// ❌ WRONG - helpers should only contain functions
return render("template", {
	helpers: {
		records: data, // Don't put data here
	},
});

// ✅ CORRECT - data goes in the main object
return render("template", {
	records: data,
	helpers: {
		uppercase: (x) => x.toUpperCase(),
	},
});
```

---

## Global Template Variables (`server.ts`)

`base_data` in `server.ts` is passed to `initialize_render()` and merged into **every** template render automatically. No need to pass these values per-route.

| Variable                   | Type / Value                         | Description                                         |
| -------------------------- | ------------------------------------ | --------------------------------------------------- |
| `site_name`                | `string` — `"Reebun App v<version>"` | App name with version from `package.json`           |
| `year`                     | `number` — current year              | Useful for copyright footers                        |
| `is_dev`                   | `boolean`                            | `true` when server started with `--dev`             |
| `url(p)`                   | `(p: string) => string`              | Ensures a path starts with `/`; use in `href` attrs |
| `menu_entries_crud_routes` | `CrudRoute[]`                        | CRUD routes flagged with `is_menu_entry: true`      |

These merge with any per-render `data` argument. Per-render data takes precedence over `base_data`.

### Using global variables in templates

```html
<footer>© {= year } {= site_name }</footer>

<a href="{= url('dashboard') }">Dashboard</a>

{#if is_dev }
<div class="dev-banner">Development mode</div>
{/if} {#each menu_entries_crud_routes as entry }
<a href="{= entry.path }">{= entry.label }</a>
{/each}
```

---

## Dev Mode Behaviour

When `is_dev` is `true`:

- **Template caching is disabled** — file changes are reflected immediately without restarting.
- **Live reload** is injected into every HTML response via `inject_live_reload()`.
- **`toJSON` / `toPrettyJSON`** debug variables are available in templates.
- **SSE endpoint** `/__reload` is registered for the live-reload client connection.
- **File watcher** is started via `start_watcher(notify_clients)` to push reload events on file changes.

---

## Migration Reference

### From EJS

| EJS                   | REE               |
| --------------------- | ----------------- |
| `<%= value %>`        | `{= value }`      |
| `<%- rawHtml %>`      | `{~ rawHtml }`    |
| `<% code %>`          | `{{ code }}`      |
| `<%- include('x') %>` | `{#include('x')}` |

### From Handlebars

| Handlebars        | REE                      |
| ----------------- | ------------------------ |
| `{{ value }}`     | `{= value }`             |
| `{{{ raw }}}`     | `{~ raw }`               |
| `{{#each items}}` | `{#each items as item }` |
| `{{#if cond}}`    | `{#if cond }`            |

### From Svelte

| Svelte                  | REE                      |
| ----------------------- | ------------------------ |
| `{value}`               | `{= value }`             |
| `{@html raw}`           | `{~ raw }`               |
| `{#each items as item}` | `{#each items as item }` |
| `{#if cond}`            | `{#if cond }`            |

---

## Complete Page Example

```ree
{#layout('layouts/main', { pageTitle: 'Product Catalog' })}

{{ const featured = data.products.filter(p => p.featured) }}
{{ const regular = data.products.filter(p => !p.featured) }}

<section class="featured">
  <h2>Featured Products</h2>
  <div class="grid">
    {#each featured as product, index }
      {@product-card({ product, badge: index === 0 ? 'NEW' : null })}
    {:else}
      <p>No featured products</p>
    {/each}
  </div>
</section>

<section class="catalog">
  <h2>All Products</h2>
  {#if regular.length > 0 }
    <div class="grid">
      {#each regular as product }
        {@product-card({ product })}
      {/each}
    </div>
  {:else}
    <p>Coming soon!</p>
  {/if}
</section>

{@newsletter-signup()}
```

---

## Complete Route Handler Example with Helpers

```typescript
import { render } from "$lib/render";
import { get_products } from "$lib/db";

export async function GET_products(req: BunRequest) {
	const products = await get_products();

	return render("products/list", {
		data: {
			products,
			page_title: "Our Products",
		},
		helpers: {
			// Format money (cents to dollars)
			price: (cents) => `$${(cents / 100).toFixed(2)}`,

			// Format date
			publish_date: (iso) => new Date(iso).toLocaleDateString("en-US"),

			// Stock status with conditional styling
			stock_badge: (quantity) => {
				if (quantity === 0) return '<span class="badge-red">Out of Stock</span>';
				if (quantity < 5) return '<span class="badge-yellow">Low Stock</span>';
				return '<span class="badge-green">In Stock</span>';
			},

			// Category color
			category_color: (category) => {
				const colors = { electronics: "blue", clothing: "pink", books: "purple" };
				return colors[category] || "gray";
			},
		},
		req,
	});
}
```

**Corresponding template:**

```ree
{#layout("layouts/shop")}

<h1>{= data.page_title }</h1>

<div class="product-grid">
  {#each data.products as product }
    <div class="product-card category-{= category_color(product.category) }">
      <h3>{= product.name }</h3>
      <p class="description">{= product.description }</p>

      <div class="price">{= price(product.price_cents) }</div>
      <div class="meta">{~ stock_badge(product.quantity) }</div>
      <div class="date">Available since {= publish_date(product.launch_date) }</div>

      <button>Add to Cart</button>
    </div>
  {:else}
    <p>No products available.</p>
  {/each}
</div>
```
