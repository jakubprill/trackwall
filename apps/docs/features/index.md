---
title: All features
description: Every feature of Trackwall on one page, grouped by what it helps with.
---

<script setup lang="ts">
// A bound href does not get the site base the way Markdown links do, so the links go through withBase.
import { withBase } from "vitepress";
import { data as groups } from "./features.data.ts";
</script>

# All features

Everything Trackwall does today, grouped by what it helps with. Each name opens the feature's page.

<template v-for="group in groups" :key="group.text">
<h2 :id="group.text.toLowerCase()">{{ group.text }}</h2>

<table class="feature-list">
  <tbody>
    <tr v-for="feature in group.items" :key="feature.link">
      <td><a :href="withBase(feature.link)">{{ feature.text }}</a></td>
      <td>{{ feature.description }}</td>
    </tr>
  </tbody>
</table>

</template>
