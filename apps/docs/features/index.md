---
title: All features
description: Every feature of Trackwall on one page, grouped by what it helps with.
---

<script setup lang="ts">
import { data as areas } from "./features.data.ts";
</script>

# All features

Everything Trackwall does today, grouped by what it helps with. Each name opens the feature's page.

<template v-for="area in areas" :key="area.title">

## {{ area.title }}

<table class="feature-list">
  <tbody>
    <tr v-for="feature in area.features" :key="feature.link">
      <td><a :href="feature.link">{{ feature.title }}</a></td>
      <td>{{ feature.description }}</td>
    </tr>
  </tbody>
</table>

</template>
