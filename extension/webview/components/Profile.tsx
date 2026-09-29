import type { ProfileView, SkillLevel } from "../../shared/protocol";

interface ProfileProps {
  profile: ProfileView;
  onClose: () => void;
}

const LEVEL_LABELS: Record<SkillLevel, string> = {
  emerging: "Emerging",
  developing: "Developing",
  independent: "Independent",
  not_enough_information: "Not enough information",
};

/** The local profile: levels with their evidence, and at most one recommendation. */
export function Profile({ profile, onClose }: ProfileProps) {
  const { recommendation } = profile;

  return (
    <section className="step">
      <h2 className="step__title">Your profile</h2>
      <p className="step__hint">
        A summary of activity seen in Socrates' Duck on this machine, from{" "}
        {profile.sessionCount} finished{" "}
        {profile.sessionCount === 1 ? "session" : "sessions"}. It is not an
        assessment of your ability.
      </p>

      {profile.notice !== null && (
        <p className="notice notice--warn">{profile.notice}</p>
      )}

      {recommendation !== null && (
        <div className="notice profile__recommendation">
          <strong>Recommended focus: {recommendation.label}</strong>
          <p>
            {recommendation.reason} {recommendation.evidence}
          </p>
          <p>{recommendation.tryNext}</p>
        </div>
      )}

      <dl className="profile">
        {profile.areas.map((area) => (
          <div className="profile__area" key={area.area}>
            <dt>
              <span className="profile__label">{area.label}</span>{" "}
              <span className="profile__level">{LEVEL_LABELS[area.level]}</span>
            </dt>
            <dd>{area.evidence}</dd>
          </div>
        ))}
      </dl>

      <p className="step__hint">
        To save a copy or start over, run <em>Socrates' Duck: Export Profile</em>{" "}
        or <em>Reset Profile</em> from the Command Palette.
      </p>

      <div className="step__actions">
        <button type="button" className="button button--secondary" onClick={onClose}>
          Back
        </button>
      </div>
    </section>
  );
}
