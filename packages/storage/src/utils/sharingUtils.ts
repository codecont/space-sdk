import { FullPath, Invitation, InvitationStatus } from '../types';

/**
 * Makes invitation objects that could then be
 * later sent to recipients
 *
 * @param inviter Sending public key
 * * @param inviter Sending public key
 */
export const createFileInvitations = (inviter: string, paths: FullPath[], pubkeys: string[]): Invitation[] => {
  const invites:Invitation[] = [];

  pubkeys.forEach((pubkey) => {
    const invite:Invitation = {
      inviteePublicKey: inviter,
      inviterPublicKey: pubkey,
      itemPaths: paths, // TODO resolve
      status: InvitationStatus.PENDING,
      keys: [], // TODO get from metadata
    };

    invites.push(invite);
  });

  return invites;
};
