---
title: Task templates
description: Start a new task from a ready prompt, such as "Fix a failing test" or "Bump a dependency", or from one of your own, with one click.
---

# Task templates

Start a new task from a ready prompt, such as "Fix a failing test" or "Bump a dependency", or from one of your own, with one click.

![The New task form with a row of templates above the prompt, the "Fix a failing test" template picked and its test name filled in](/screenshots/task-templates.png)

## What you get

- A row of templates above the prompt of the "New task" form, for the work you start most often.
- Prompts that already say what a good result is: a test that reproduces the bug first, the build and tests run, a report at the end.
- The part you have to fill in selected for you, so you type the test name or the dependency straight away.
- Your own templates, saved from any prompt with "Save as template", next to the built-in ones.

## How it works

Open "Sessions" and press "+" for the "New task" form. Above the prompt, under "Start from a template:", Trackwall lists its built-in templates: "Fix a failing test", "Fix a bug", "Bump a dependency", "Add tests", "Refactor without changing behaviour", "Update the documentation" and "Explain how it works". Press one and its prompt fills the box.

A template has placeholders in angle brackets, such as `<test name>` or `<dependency>`. The first one is selected when the prompt appears, so what you type replaces it. Until you fill them all in, a line under the prompt names the ones left; you can still start the task if you meant to leave one.

Picking a template never throws away what you wrote: if the prompt has your own text, the template goes below it. A prompt that is still exactly the last template is replaced by the next one you press.

Nothing starts when you pick a template. You read the prompt, choose the repo and options as for any [agent task](/features/tasks), and press "Create task".

## Use it

1. In "Sessions", press "+" for the "New task" form and choose the repo.
2. Press a template under "Start from a template:".
3. Type over the selected placeholder, and fill in any others the line under the prompt names.
4. Press "Create task".

To keep a prompt for later, write it, press "Save as template", give it a title and press "Save template". It shows with "· yours" in the row.

## Good to know

- Your templates are Markdown files in `.trackwall/task-templates` of your projects folder: the title at the top, the prompt below. You can write or edit one in any editor; the form shows it the next time it opens.
- Saving under the title of an existing template replaces it. Saved under a built-in template's title, yours takes its place; remove yours to bring the built-in one back.
- To remove one of your templates, pick it and press "Remove" under the row.
- A template fills the prompt only. The repo, model, approvals mode and the other options stay as you set them in the form.
- A template you run again and again unchanged, with its repo and options, is better as a [routine](/features/routines).
- Placeholders are lowercase words in angle brackets. Code such as `List<String>` in a prompt is never taken for one.
