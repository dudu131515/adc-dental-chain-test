from dataclasses import dataclass
from datetime import datetime

from django.db import connection
from django.db.models import Q

from adc.booking.models import SlotClaim
from adc.scheduling.models import DentalChair, DentalChairUnavailability


@dataclass(frozen=True)
class Interval:
    start: datetime
    end: datetime | None
    claim_id: int | None = None

    def overlaps(self, start, end):
        return self.start < end and (self.end is None or start < self.end)


@dataclass(frozen=True)
class Chair:
    id: int
    kind: str
    blocked: tuple[Interval, ...] = ()


@dataclass(frozen=True)
class Requirement:
    claim_id: int
    start: datetime
    end: datetime
    kind: str | None
    fixed_chair_id: int | None = None

    def overlaps(self, other):
        return self.start < other.end and other.start < self.end


def suitable_chairs(chairs, item):
    return [
        chair.id for chair in chairs
        if (item.kind is None or item.kind == chair.kind)
        and (item.fixed_chair_id is None or item.fixed_chair_id == chair.id)
        and not any(
            interval.claim_id != item.claim_id and interval.overlaps(item.start, item.end)
            for interval in chair.blocked
        )
    ]


def has_feasible_assignment(chairs, requirements):
    options = [(item, suitable_chairs(chairs, item)) for item in requirements]
    options.sort(key=lambda row: (len(row[1]), row[0].start, row[0].claim_id))
    by_chair = {chair.id: [] for chair in chairs}

    def assign(index):
        if index == len(options):
            return True
        item, chair_ids = options[index]
        for cid in chair_ids:
            existing = by_chair[cid]
            if any(item.overlaps(other) for other in existing):
                continue
            existing.append(item)
            if assign(index + 1):
                return True
            existing.pop()
        return False

    return assign(0)


def connected_requirements(candidate, requirements):
    group = [candidate]
    remaining = list(requirements)
    for added in group:
        related = [
            item for item in remaining
            if item.overlaps(added) and (item.kind is None or added.kind is None or item.kind == added.kind)
        ]
        group.extend(related)
        remaining = [item for item in remaining if item not in related]
    return group


@dataclass(frozen=True)
class ClinicCapacity:
    chairs: list[Chair]
    requirements: list[Requirement]

    def can_fit(self, candidate):
        return has_feasible_assignment(self.chairs, connected_requirements(candidate, self.requirements))


def load_capacity(clinic_id, as_of, *, exclude_claim_id=None):
    catalog = list(DentalChair.objects.filter(clinic_id=clinic_id, status="AVAILABLE").order_by("pk"))
    blocked = {chair.pk: [] for chair in catalog}
    for outage in DentalChairUnavailability.objects.filter(chair_id__in=blocked):
        blocked[outage.chair_id].append(Interval(outage.start_at, outage.end_at))

    fixed = {}
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT cu.chair_id, cu.assigned_at, cu.released_at, sc.claim_id, sc.end_at
            FROM chair_usage AS cu
            JOIN appointment AS a ON a.appointment_id = cu.appointment_id
            JOIN slot_claim AS sc ON sc.claim_id = a.claim_id
            JOIN dental_chair AS dc ON dc.chair_id = cu.chair_id
            WHERE dc.clinic_id = %s
            """,
            [clinic_id],
        )
        for chair, started, ended, claim, planned_end in cursor.fetchall():
            if ended is None and claim != exclude_claim_id:
                fixed[claim] = chair
            if chair not in blocked or (ended is None and claim == exclude_claim_id):
                continue
            blocked_until = ended
            if blocked_until is None and as_of < planned_end:
                blocked_until = planned_end
            blocked[chair].append(Interval(started, blocked_until, claim))

    active = SlotClaim.objects.filter(clinic_id=clinic_id).filter(
        Q(status="CONFIRMED") | Q(status="HOLD", expires_at__gt=as_of),
    )
    if exclude_claim_id is not None:
        active = active.exclude(pk=exclude_claim_id)
    requirements = [
        Requirement(item.pk, item.start_at, item.end_at, item.required_chair_kind, fixed.get(item.pk))
        for item in active
    ]
    return ClinicCapacity(
        [Chair(item.pk, item.chair_kind, tuple(blocked[item.pk])) for item in catalog],
        requirements,
    )
