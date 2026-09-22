export const dynamic = 'force-dynamic';
import { Forgot } from '@gitroom/frontend/components/auth/forgot';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: 'Creatu — Reset password',
  description: '',
};
export default async function Auth() {
  return <Forgot />;
}
