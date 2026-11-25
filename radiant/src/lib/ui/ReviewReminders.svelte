<script lang="ts">
  import { onMount } from 'svelte';
  import { localDate } from '../core/review';
  import {
    alreadyReminded, markReminded, readReviews, reviewReminderEvent, reviewRemindersEnabled
  } from './reviewStore';
  import type { AppController } from './controller.svelte';

  let { c }: { c: AppController } = $props();

  onMount(() => {
    if (!c.host.notifyReview || !c.host.reviewNotificationPermission) return;
    let active = true;
    let running = false;
    let sentOn = '';

    async function notifyIfDue() {
      const now = Date.now();
      const day = localDate(now);
      if (!active || !reviewRemindersEnabled() || sentOn === day || alreadyReminded(day)) return;
      const count = readReviews().schedules.filter((schedule) => {
        const next = schedule.dates[schedule.completed];
        return next !== undefined && next <= now;
      }).length;
      if (!count || !(await c.host.reviewNotificationPermission!(false)) || !active || !reviewRemindersEnabled()) return;
      await c.host.notifyReview!(count);
      sentOn = day;
      markReminded(day);
    }

    async function poll() {
      if (!active || running || !reviewRemindersEnabled()) return;
      running = true;
      try {
        // All document windows share the daily reminder and its delivery marker.
        if (navigator.locks) await navigator.locks.request('radiant:review-reminder', notifyIfDue);
        else await notifyIfDue();
      } catch {
        // The Due queue remains available if native notifications are unavailable.
      } finally {
        running = false;
      }
    }

    const update = () => void poll();
    const timer = window.setInterval(update, 30_000);
    window.addEventListener(reviewReminderEvent, update);
    window.addEventListener('focus', update);
    window.addEventListener('storage', update);
    update();
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(reviewReminderEvent, update);
      window.removeEventListener('focus', update);
      window.removeEventListener('storage', update);
    };
  });
</script>
