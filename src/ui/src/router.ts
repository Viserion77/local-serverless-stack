import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'overview',
    component: () => import('./pages/OverviewPage.vue'),
    meta: { title: 'Overview' },
  },
  {
    path: '/services',
    name: 'services',
    component: () => import('./pages/ServicesPage.vue'),
    meta: { title: 'Services' },
  },
  {
    path: '/services/:name',
    name: 'service-detail',
    component: () => import('./pages/ServiceDetailPage.vue'),
    props: route => ({ serviceName: String(route.params.name) }),
    meta: { title: 'Service' },
  },
  {
    path: '/queues',
    name: 'queues',
    component: () => import('./pages/QueuesPage.vue'),
    meta: { title: 'Queues' },
  },
  {
    path: '/queues/:name',
    name: 'queue-detail',
    component: () => import('./pages/QueueDetailPage.vue'),
    props: route => ({ queueName: String(route.params.name) }),
    meta: { title: 'Queue' },
  },
  {
    path: '/buckets',
    name: 'buckets',
    component: () => import('./pages/BucketsPage.vue'),
    meta: { title: 'S3 Buckets' },
  },
  {
    path: '/buckets/:name',
    name: 'bucket-detail',
    component: () => import('./pages/BucketDetailPage.vue'),
    props: route => ({ bucketName: String(route.params.name) }),
    meta: { title: 'S3 Bucket' },
  },
  {
    path: '/dynamo',
    name: 'dynamo',
    component: () => import('./pages/DynamoPage.vue'),
    meta: { title: 'DynamoDB' },
  },
  {
    path: '/dynamo/:name',
    name: 'dynamo-table',
    component: () => import('./pages/DynamoTablePage.vue'),
    props: route => ({ tableName: String(route.params.name) }),
    meta: { title: 'DynamoDB Table' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
