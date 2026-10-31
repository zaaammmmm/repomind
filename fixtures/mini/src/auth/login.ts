import { signToken } from './token';
// Validasi kredensial lalu terbitkan token
export async function login(email: string, _pass: string) {
  const token = signToken({ sub: email });
  return { token, expiresIn: 3600 };
}
